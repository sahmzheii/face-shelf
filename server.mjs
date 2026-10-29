import { createServer } from 'node:http'
import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('./public/', import.meta.url))
const port = Number(process.env.PORT || 4173)
const facebookConfig = {
  accessToken: process.env.FB_ACCESS_TOKEN || '',
  version: process.env.FB_GRAPH_VERSION || 'v26.0',
  profile: null
}
const oauthStates = new Map()
const pendingPageSelections = new Map()

const mimeTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml'
}

function sendJson(res, status, payload) {
  res.writeHead(status, { 'Content-Type': mimeTypes['.json'] })
  res.end(JSON.stringify(payload))
}

function redirect(res, location) {
  res.writeHead(302, { Location: location, 'Cache-Control': 'no-store' })
  res.end()
}

function appUrlWithMessage(key, value = '') {
  const url = new URL(`http://localhost:${port}/`)
  url.searchParams.set(key, value)
  return url.toString()
}

function oauthRedirectUri() {
  return process.env.FACEBOOK_REDIRECT_URI || `http://localhost:${port}/auth/facebook/callback`
}

function cleanupOAuthData() {
  const now = Date.now()
  for (const [key, value] of oauthStates) {
    if (value.expiresAt < now) oauthStates.delete(key)
  }
  for (const [key, value] of pendingPageSelections) {
    if (value.expiresAt < now) pendingPageSelections.delete(key)
  }
}

async function readJson(req) {
  const chunks = []
  let size = 0

  for await (const chunk of req) {
    size += chunk.length
    if (size > 20_000) throw new Error('Request body is too large')
    chunks.push(chunk)
  }

  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
}

function extractImages(attachments = []) {
  const images = []
  const imageIndexes = new Map()

  const getPhotoId = (targetUrl) => {
    if (!targetUrl) return null
    try {
      const url = new URL(targetUrl)
      return url.searchParams.get('fbid') || url.pathname.match(/\/(\d+)\/?$/)?.[1] || null
    } catch {
      return null
    }
  }

  const visit = (attachment) => {
    const image = attachment?.media?.image
    if (image?.src) {
      let imageKey = image.src
      try {
        const imageUrl = new URL(image.src)
        imageKey = `${imageUrl.host}${imageUrl.pathname}`
      } catch {}

      const targetUrl = attachment.target?.url || attachment.url || null
      const facebookPhotoId = getPhotoId(targetUrl)
      const existingIndex = imageIndexes.get(imageKey)

      if (existingIndex === undefined) {
        imageIndexes.set(imageKey, images.length)
        images.push({
          id: `${images.length + 1}`,
          imageUrl: image.src,
          width: image.width || null,
          height: image.height || null,
          targetUrl,
          facebookPhotoId
        })
      } else if (!images[existingIndex].facebookPhotoId && facebookPhotoId) {
        images[existingIndex].facebookPhotoId = facebookPhotoId
        images[existingIndex].targetUrl = targetUrl
      }
    }

    for (const child of attachment?.subattachments?.data || []) visit(child)
  }

  for (const attachment of attachments) visit(attachment)
  return images
}

function captionIsSoldOut(caption = '') {
  const normalized = caption.normalize('NFKC').toLowerCase()
  const hasEnglishKeyword = /\b(?:sold\s*out|soldout|sold|out)\b/i.test(normalized)
  const hasThaiKeyword = ['ออกแล้ว', 'ขายแล้ว', 'ออก'].some((keyword) => normalized.includes(keyword))
  return hasEnglishKeyword || hasThaiKeyword
}

async function addPhotoCaptions(products, version, token) {
  const enriched = []

  for (let index = 0; index < products.length; index += 10) {
    const chunk = products.slice(index, index + 10)
    const results = await Promise.all(chunk.map(async (product) => {
      if (!product.facebookPhotoId) return { ...product, caption: '', sold: false }

      const endpoint = new URL(`https://graph.facebook.com/${version}/${product.facebookPhotoId}`)
      endpoint.searchParams.set('fields', 'id,name')
      endpoint.searchParams.set('access_token', token)

      try {
        const response = await fetch(endpoint)
        const data = await response.json()
        const caption = response.ok ? data.name || '' : ''
        return {
          ...product,
          caption,
          originalCaption: caption,
          sold: captionIsSoldOut(caption)
        }
      } catch {
        return { ...product, caption: '', originalCaption: '', sold: false }
      }
    }))

    enriched.push(...results)
  }

  return enriched
}

async function resolvePostId(value) {
  const input = value.trim()
  if (/^\d+_\d+$/.test(input)) return input
  if (/^\d+$/.test(input)) return `${facebookConfig.profile.id}_${input}`

  if (/^pfbid/i.test(input)) {
    throw new Error('กรุณาวางลิงก์โพสต์แบบเต็ม แทนการวางเฉพาะ pfbid')
  }

  let sharedUrl
  try {
    sharedUrl = new URL(input)
  } catch {
    return input
  }

  const hostname = sharedUrl.hostname.toLowerCase()
  if (hostname !== 'facebook.com' && !hostname.endsWith('.facebook.com')) {
    throw new Error('รองรับเฉพาะลิงก์โพสต์จาก facebook.com')
  }

  const response = await fetch(sharedUrl, {
    redirect: 'follow',
    headers: { 'User-Agent': 'Mozilla/5.0' }
  })
  if (!response.ok) throw new Error('เปิดลิงก์ Facebook ไม่สำเร็จ')

  const html = await response.text()
  const metaUrl = html.match(/property=["']og:url["'][^>]*content=["']([^"']+)/i)?.[1]
  const canonicalUrl = (metaUrl || response.url).replaceAll('&amp;', '&')
  const postId = new URL(canonicalUrl).pathname.match(/\/(\d+)\/?$/)?.[1]

  if (!postId) throw new Error('ไม่พบ Post ID จากลิงก์นี้ กรุณาตรวจว่าเป็นโพสต์ของ Page ที่เชื่อมต่อ')
  return `${facebookConfig.profile.id}_${postId}`
}

async function importFacebookPost(req, res) {
  try {
    const { postId } = await readJson(req)
    const token = facebookConfig.accessToken
    const version = facebookConfig.version

    if (!postId?.trim()) return sendJson(res, 400, { error: 'กรุณาระบุ Facebook Post ID' })
    if (!token) {
      return sendJson(res, 503, {
        error: 'ยังไม่ได้ตั้งค่า FB_ACCESS_TOKEN ที่ฝั่ง server',
        code: 'TOKEN_NOT_CONFIGURED'
      })
    }

    const resolvedPostId = await resolvePostId(postId)
    const fields = 'id,message,permalink_url,created_time,attachments.limit(100){media_type,media,target,url,subattachments.limit(100){media_type,media,target,url}}'
    const endpoint = new URL(`https://graph.facebook.com/${version}/${encodeURIComponent(resolvedPostId)}`)
    endpoint.searchParams.set('fields', fields)
    endpoint.searchParams.set('access_token', token)

    const response = await fetch(endpoint)
    const data = await response.json()

    if (!response.ok) {
      return sendJson(res, response.status, {
        error: data?.error?.message || 'Facebook Graph API error',
        code: data?.error?.code || 'FACEBOOK_ERROR'
      })
    }

    const products = await addPhotoCaptions(extractImages(data.attachments?.data), version, token)

    sendJson(res, 200, {
      post: {
        id: data.id,
        message: data.message || '',
        permalinkUrl: data.permalink_url || '',
        createdTime: data.created_time || ''
      },
      products
    })
  } catch (error) {
    sendJson(res, 400, { error: error.message || 'นำเข้าโพสต์ไม่สำเร็จ' })
  }
}

async function syncFacebookPhotos(req, res) {
  try {
    if (!facebookConfig.accessToken) {
      return sendJson(res, 503, { error: 'กรุณาเชื่อมต่อ Facebook ก่อน' })
    }

    const { photoIds } = await readJson(req)
    const uniquePhotoIds = [...new Set(
      (Array.isArray(photoIds) ? photoIds : []).filter((photoId) => /^\d+$/.test(String(photoId)))
    )]

    if (uniquePhotoIds.length === 0) return sendJson(res, 200, { items: [] })
    if (uniquePhotoIds.length > 500) return sendJson(res, 400, { error: 'Sync ได้สูงสุด 500 รูปต่อครั้ง' })

    const products = uniquePhotoIds.map((facebookPhotoId) => ({ facebookPhotoId: String(facebookPhotoId) }))
    const synced = await addPhotoCaptions(products, facebookConfig.version, facebookConfig.accessToken)

    sendJson(res, 200, {
      items: synced.map(({ facebookPhotoId, caption, sold }) => ({ facebookPhotoId, caption, sold }))
    })
  } catch (error) {
    sendJson(res, 400, { error: error.message || 'Sync สถานะขายหมดไม่สำเร็จ' })
  }
}

async function configureFacebook(req, res) {
  try {
    const { accessToken, version } = await readJson(req)
    if (!accessToken?.trim()) return sendJson(res, 400, { error: 'กรุณากรอก Page Access Token' })

    const graphVersion = version?.trim() || 'v26.0'
    if (!/^v\d+\.\d+$/.test(graphVersion)) {
      return sendJson(res, 400, { error: 'Graph API version ต้องมีรูปแบบ เช่น v24.0' })
    }

    const endpoint = new URL(`https://graph.facebook.com/${graphVersion}/me`)
    endpoint.searchParams.set('fields', 'id,name,category')
    endpoint.searchParams.set('access_token', accessToken.trim())

    const response = await fetch(endpoint)
    const data = await response.json()
    if (!response.ok) {
      return sendJson(res, response.status, {
        error: data?.error?.message || 'ตรวจสอบ Facebook token ไม่สำเร็จ'
      })
    }

    if (!data.category) {
      return sendJson(res, 400, {
        error: 'Token นี้เป็น User Access Token กรุณาคัดลอก access_token ของ Page จากผลลัพธ์ /me/accounts'
      })
    }

    facebookConfig.accessToken = accessToken.trim()
    facebookConfig.version = graphVersion
    facebookConfig.profile = {
      id: data.id,
      name: data.name || 'Facebook Page',
      category: data.category
    }
    sendJson(res, 200, { ok: true, profile: facebookConfig.profile, version: graphVersion })
  } catch (error) {
    sendJson(res, 400, { error: error.message || 'เชื่อมต่อ Facebook ไม่สำเร็จ' })
  }
}

function startFacebookLogin(res) {
  cleanupOAuthData()
  const appId = process.env.FACEBOOK_APP_ID
  const appSecret = process.env.FACEBOOK_APP_SECRET

  if (!appId || !appSecret) {
    return redirect(res, appUrlWithMessage(
      'facebook_error',
      'ยังไม่ได้ตั้งค่า FACEBOOK_APP_ID และ FACEBOOK_APP_SECRET ในไฟล์ .env'
    ))
  }

  const state = randomBytes(24).toString('hex')
  oauthStates.set(state, { expiresAt: Date.now() + 10 * 60 * 1000 })

  const authorizeUrl = new URL(`https://www.facebook.com/${facebookConfig.version}/dialog/oauth`)
  authorizeUrl.searchParams.set('client_id', appId)
  authorizeUrl.searchParams.set('redirect_uri', oauthRedirectUri())
  authorizeUrl.searchParams.set('state', state)
  authorizeUrl.searchParams.set('scope', 'pages_show_list,pages_read_engagement')
  authorizeUrl.searchParams.set('response_type', 'code')
  return redirect(res, authorizeUrl.toString())
}

async function finishFacebookLogin(req, res) {
  cleanupOAuthData()
  const callbackUrl = new URL(req.url, `http://localhost:${port}`)
  const state = callbackUrl.searchParams.get('state')
  const code = callbackUrl.searchParams.get('code')
  const oauthError = callbackUrl.searchParams.get('error_message') || callbackUrl.searchParams.get('error_description')

  if (oauthError) return redirect(res, appUrlWithMessage('facebook_error', oauthError))
  if (!state || !code || !oauthStates.has(state)) {
    return redirect(res, appUrlWithMessage('facebook_error', 'Facebook Login หมดอายุหรือ state ไม่ถูกต้อง'))
  }
  oauthStates.delete(state)

  try {
    const appId = process.env.FACEBOOK_APP_ID
    const appSecret = process.env.FACEBOOK_APP_SECRET
    const tokenUrl = new URL(`https://graph.facebook.com/${facebookConfig.version}/oauth/access_token`)
    tokenUrl.searchParams.set('client_id', appId)
    tokenUrl.searchParams.set('client_secret', appSecret)
    tokenUrl.searchParams.set('redirect_uri', oauthRedirectUri())
    tokenUrl.searchParams.set('code', code)

    const tokenResponse = await fetch(tokenUrl)
    const tokenData = await tokenResponse.json()
    if (!tokenResponse.ok || !tokenData.access_token) {
      throw new Error(tokenData?.error?.message || 'แลก Facebook access token ไม่สำเร็จ')
    }

    const exchangeUrl = new URL(`https://graph.facebook.com/${facebookConfig.version}/oauth/access_token`)
    exchangeUrl.searchParams.set('grant_type', 'fb_exchange_token')
    exchangeUrl.searchParams.set('client_id', appId)
    exchangeUrl.searchParams.set('client_secret', appSecret)
    exchangeUrl.searchParams.set('fb_exchange_token', tokenData.access_token)
    const exchangeResponse = await fetch(exchangeUrl)
    const exchangeData = await exchangeResponse.json()
    const userToken = exchangeResponse.ok && exchangeData.access_token
      ? exchangeData.access_token
      : tokenData.access_token

    const pagesUrl = new URL(`https://graph.facebook.com/${facebookConfig.version}/me/accounts`)
    pagesUrl.searchParams.set('fields', 'id,name,category,access_token,tasks')
    pagesUrl.searchParams.set('access_token', userToken)
    const pagesResponse = await fetch(pagesUrl)
    const pagesData = await pagesResponse.json()
    if (!pagesResponse.ok) throw new Error(pagesData?.error?.message || 'ดึงรายการ Page ไม่สำเร็จ')

    const pages = (pagesData.data || []).filter((page) => page.access_token)
    if (pages.length === 0) throw new Error('ไม่พบ Facebook Page ที่บัญชีนี้จัดการ')

    if (pages.length === 1) {
      facebookConfig.accessToken = pages[0].access_token
      facebookConfig.profile = { id: pages[0].id, name: pages[0].name, category: pages[0].category || '' }
      return redirect(res, appUrlWithMessage('facebook_connected', '1'))
    }

    const loginId = randomBytes(24).toString('hex')
    pendingPageSelections.set(loginId, {
      expiresAt: Date.now() + 10 * 60 * 1000,
      pages
    })
    return redirect(res, appUrlWithMessage('facebook_pages', loginId))
  } catch (error) {
    return redirect(res, appUrlWithMessage('facebook_error', error.message || 'Facebook Login ไม่สำเร็จ'))
  }
}

function listFacebookPages(req, res) {
  cleanupOAuthData()
  const url = new URL(req.url, `http://localhost:${port}`)
  const login = pendingPageSelections.get(url.searchParams.get('login'))
  if (!login) return sendJson(res, 404, { error: 'รายการ Page หมดอายุ กรุณา Login ใหม่' })

  sendJson(res, 200, {
    pages: login.pages.map(({ id, name, category }) => ({ id, name, category: category || '' }))
  })
}

async function selectFacebookPage(req, res) {
  cleanupOAuthData()
  const { loginId, pageId } = await readJson(req)
  const login = pendingPageSelections.get(loginId)
  if (!login) return sendJson(res, 404, { error: 'รายการ Page หมดอายุ กรุณา Login ใหม่' })

  const page = login.pages.find((item) => item.id === pageId)
  if (!page) return sendJson(res, 404, { error: 'ไม่พบ Page ที่เลือก' })

  facebookConfig.accessToken = page.access_token
  facebookConfig.profile = { id: page.id, name: page.name, category: page.category || '' }
  pendingPageSelections.delete(loginId)
  sendJson(res, 200, { ok: true, profile: facebookConfig.profile })
}

async function serveStatic(req, res) {
  const requested = new URL(req.url, 'http://localhost').pathname
  const relative = requested === '/' ? 'index.html' : requested.slice(1)
  const filePath = normalize(join(root, relative))

  if (!filePath.startsWith(root)) return sendJson(res, 403, { error: 'Forbidden' })

  try {
    const body = await readFile(filePath)
    res.writeHead(200, { 'Content-Type': mimeTypes[extname(filePath)] || 'application/octet-stream' })
    res.end(body)
  } catch {
    sendJson(res, 404, { error: 'Not found' })
  }
}

const server = createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/auth/facebook') {
    return startFacebookLogin(res)
  }

  if (req.method === 'GET' && req.url.startsWith('/auth/facebook/callback')) {
    return finishFacebookLogin(req, res)
  }

  if (req.method === 'GET' && req.url.startsWith('/api/facebook/pages')) {
    return listFacebookPages(req, res)
  }

  if (req.method === 'POST' && req.url === '/api/facebook/select-page') {
    return selectFacebookPage(req, res)
  }

  if (req.method === 'POST' && req.url === '/api/facebook/config') {
    return configureFacebook(req, res)
  }

  if (req.method === 'POST' && req.url === '/api/facebook/import') {
    return importFacebookPost(req, res)
  }

  if (req.method === 'POST' && req.url === '/api/facebook/sync') {
    return syncFacebookPhotos(req, res)
  }

  if (req.method === 'GET' && req.url === '/api/health') {
    return sendJson(res, 200, {
      ok: true,
      facebookConfigured: Boolean(facebookConfig.accessToken),
      facebookProfile: facebookConfig.profile,
      graphVersion: facebookConfig.version
    })
  }

  if (req.method !== 'GET') return sendJson(res, 405, { error: 'Method not allowed' })
  return serveStatic(req, res)
})

server.listen(port, () => {
  console.log(`Face Shelf: http://localhost:${port}`)
})
