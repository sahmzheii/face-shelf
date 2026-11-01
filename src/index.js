const SESSION_COOKIE = 'face_shelf_session'
const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60
const OAUTH_TTL_MS = 10 * 60 * 1000
const encoder = new TextEncoder()
const decoder = new TextDecoder()

function json(payload, status = 200, headers = {}) {
  return Response.json(payload, {
    status,
    headers: { 'Cache-Control': 'no-store', ...headers }
  })
}

function redirect(location, headers = {}) {
  return new Response(null, {
    status: 302,
    headers: { Location: location, 'Cache-Control': 'no-store', ...headers }
  })
}

function escapeHtml(value = '') {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function renderMarkdownLinks(value = '') {
  const pattern = /\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)|(https?:\/\/[^\s<]+)/gi
  let html = ''
  let lastIndex = 0

  for (const match of String(value).matchAll(pattern)) {
    html += escapeHtml(String(value).slice(lastIndex, match.index))
    const url = match[2] || match[3]
    const label = match[1] || url
    html += `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)}</a>`
    lastIndex = match.index + match[0].length
  }

  html += escapeHtml(String(value).slice(lastIndex))
  return html.replaceAll('\n', '<br>')
}

async function readJson(request) {
  const text = await request.text()
  if (text.length > 1_000_000) throw new Error('Request body is too large')
  return JSON.parse(text || '{}')
}

function randomId(size = 24) {
  const bytes = new Uint8Array(size)
  crypto.getRandomValues(bytes)
  return [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('')
}

function toBase64(bytes) {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function fromBase64(value) {
  const binary = atob(value)
  return Uint8Array.from(binary, (character) => character.charCodeAt(0))
}

function fromHex(value) {
  if (!/^[0-9a-f]+$/i.test(value) || value.length % 2 !== 0) return null
  return Uint8Array.from(value.match(/.{2}/g), (byte) => Number.parseInt(byte, 16))
}

async function verifyWebhookSignature(body, signature, appSecret) {
  if (!appSecret || !signature?.startsWith('sha256=')) return false
  const expected = fromHex(signature.slice(7))
  if (!expected) return false
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(appSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify']
  )
  return crypto.subtle.verify('HMAC', key, expected, encoder.encode(body))
}

async function getEncryptionKey(env) {
  if (!env.TOKEN_ENCRYPTION_KEY) {
    throw new Error('ยังไม่ได้ตั้งค่า TOKEN_ENCRYPTION_KEY')
  }
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(env.TOKEN_ENCRYPTION_KEY))
  return crypto.subtle.importKey('raw', digest, 'AES-GCM', false, ['encrypt', 'decrypt'])
}

async function encryptText(value, env) {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const key = await getEncryptionKey(env)
  const encrypted = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    encoder.encode(value)
  ))
  const combined = new Uint8Array(iv.length + encrypted.length)
  combined.set(iv)
  combined.set(encrypted, iv.length)
  return toBase64(combined)
}

async function decryptText(value, env) {
  const combined = fromBase64(value)
  const iv = combined.slice(0, 12)
  const encrypted = combined.slice(12)
  const key = await getEncryptionKey(env)
  const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, encrypted)
  return decoder.decode(decrypted)
}

function parseCookies(request) {
  const cookies = new Map()
  for (const part of (request.headers.get('Cookie') || '').split(';')) {
    const separator = part.indexOf('=')
    if (separator < 0) continue
    cookies.set(part.slice(0, separator).trim(), decodeURIComponent(part.slice(separator + 1).trim()))
  }
  return cookies
}

function sessionCookie(request, sessionId) {
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : ''
  return `${SESSION_COOKIE}=${encodeURIComponent(sessionId)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_SECONDS}${secure}`
}

function clearSessionCookie(request) {
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : ''
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`
}

function appUrlWithMessage(request, key, value = '') {
  const url = new URL('/', request.url)
  url.searchParams.set(key, value)
  return url.toString()
}

function oauthRedirectUri(request, env) {
  return env.FACEBOOK_REDIRECT_URI || new URL('/auth/facebook/callback', request.url).toString()
}

function graphVersion(env, connection) {
  return connection?.graphVersion || env.FB_GRAPH_VERSION || 'v26.0'
}

async function cleanupExpired(db) {
  const now = Date.now()
  await db.batch([
    db.prepare('DELETE FROM oauth_states WHERE expires_at < ?').bind(now),
    db.prepare('DELETE FROM pending_page_selections WHERE expires_at < ?').bind(now),
    db.prepare('DELETE FROM admin_sessions WHERE expires_at < ?').bind(now)
  ])
}

async function getSessionContext(request, env) {
  const sessionId = parseCookies(request).get(SESSION_COOKIE)
  if (!sessionId) return null

  const row = await env.DB.prepare(`
    SELECT s.id AS session_id, s.page_id, s.expires_at,
      c.page_name, c.category, c.access_token_cipher, c.graph_version
    FROM admin_sessions s
    JOIN page_connections c ON c.page_id = s.page_id
    WHERE s.id = ?
  `).bind(sessionId).first()

  if (!row || row.expires_at < Date.now()) {
    if (row) await env.DB.prepare('DELETE FROM admin_sessions WHERE id = ?').bind(sessionId).run()
    return null
  }

  return {
    sessionId: row.session_id,
    pageId: row.page_id,
    pageName: row.page_name,
    category: row.category,
    accessToken: await decryptText(row.access_token_cipher, env),
    graphVersion: row.graph_version
  }
}

async function saveConnection(env, page, version) {
  const tokenCipher = await encryptText(page.access_token, env)
  await env.DB.prepare(`
    INSERT INTO page_connections
      (page_id, page_name, category, access_token_cipher, graph_version, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(page_id) DO UPDATE SET
      page_name = excluded.page_name,
      category = excluded.category,
      access_token_cipher = excluded.access_token_cipher,
      graph_version = excluded.graph_version,
      updated_at = excluded.updated_at
  `).bind(
    String(page.id),
    page.name || 'Facebook Page',
    page.category || '',
    tokenCipher,
    version,
    Date.now()
  ).run()
}

async function createSession(env, pageId) {
  const id = randomId()
  const now = Date.now()
  await env.DB.prepare(`
    INSERT INTO admin_sessions (id, page_id, expires_at, created_at)
    VALUES (?, ?, ?, ?)
  `).bind(id, String(pageId), now + SESSION_TTL_SECONDS * 1000, now).run()
  return id
}

function extractImages(attachments = []) {
  const images = []
  const imageIndexes = new Map()

  const getPhotoId = (targetUrl) => {
    if (!targetUrl) return null
    try {
      const url = new URL(targetUrl)
      const fbid = url.searchParams.get('fbid')
      if (fbid) return fbid
      if (!url.pathname.includes('/photos/')) return null
      return url.pathname.match(/\/(\d+)\/?$/)?.[1] || null
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
          facebookPhotoId,
          attachmentCaption: attachment.description || attachment.title || ''
        })
      } else {
        if (!images[existingIndex].facebookPhotoId && facebookPhotoId) {
          images[existingIndex].facebookPhotoId = facebookPhotoId
          images[existingIndex].targetUrl = targetUrl
        }
        if (!images[existingIndex].attachmentCaption) {
          images[existingIndex].attachmentCaption = attachment.description || attachment.title || ''
        }
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

  for (let index = 0; index < products.length; index += 50) {
    const chunk = products.slice(index, index + 50)
    const photoIds = [...new Set(chunk.map((product) => product.facebookPhotoId).filter(Boolean))]
    let photoDataById = {}

    if (photoIds.length > 0) {
      const endpoint = new URL(`https://graph.facebook.com/${version}/`)
      endpoint.searchParams.set('ids', photoIds.join(','))
      endpoint.searchParams.set('fields', 'id,name')
      endpoint.searchParams.set('access_token', token)

      try {
        const response = await fetch(endpoint)
        const data = await response.json()
        if (response.ok && data && typeof data === 'object') photoDataById = data
      } catch {}
    }

    const results = chunk.map((product) => {
      const attachmentResolved = Boolean(product.attachmentCaptionResolved)
      const hasAttachmentCaption = Boolean(product.attachmentCaption)
      const fallbackCaption = attachmentResolved || hasAttachmentCaption
        ? product.attachmentCaption || ''
        : product.caption || ''
      const fallbackResolved = attachmentResolved || hasAttachmentCaption
      if (!product.facebookPhotoId) {
        return {
          ...product,
          caption: fallbackCaption,
          originalCaption: fallbackCaption,
          sold: fallbackResolved
            ? captionIsSoldOut(fallbackCaption)
            : Boolean(product.sold),
          captionResolved: fallbackResolved
        }
      }

      const photoData = photoDataById[String(product.facebookPhotoId)]
      if (photoData?.id && !photoData.error) {
        const caption = typeof photoData.name === 'string' ? photoData.name : fallbackCaption
        return {
          ...product,
          caption,
          originalCaption: caption,
          sold: captionIsSoldOut(caption),
          captionResolved: true
        }
      }

      return {
        ...product,
        caption: fallbackCaption,
        originalCaption: fallbackCaption || product.originalCaption || '',
        sold: fallbackResolved
          ? captionIsSoldOut(fallbackCaption)
          : Boolean(product.sold),
        captionResolved: fallbackResolved
      }
    })
    enriched.push(...results)
  }

  return enriched
}

async function resolvePostId(value, connection) {
  const input = value.trim()
  if (/^\d+_\d+$/.test(input)) return input
  if (/^\d+$/.test(input)) return `${connection.pageId}_${input}`

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
  return `${connection.pageId}_${postId}`
}

function rowToProduct(row) {
  return {
    id: row.id,
    postId: row.post_id,
    postCreatedTime: row.created_time || '',
    facebookPhotoId: row.facebook_photo_id,
    imageUrl: row.image_url,
    width: row.width,
    height: row.height,
    targetUrl: row.target_url,
    caption: row.caption || '',
    originalCaption: row.original_caption || '',
    sold: Boolean(row.sold),
    isArtwork: Boolean(row.is_artwork)
  }
}

async function runBatches(db, statements, size = 75) {
  for (let index = 0; index < statements.length; index += size) {
    await db.batch(statements.slice(index, index + size))
  }
}

async function saveImportedPost(env, connection, post, products) {
  const existing = await env.DB.prepare(`
    SELECT id, facebook_photo_id, image_url, target_url, sort_index, is_artwork
    FROM products
    WHERE page_id = ? AND post_id = ?
  `).bind(connection.pageId, post.id).all()
  const existingArtwork = (existing.results || []).filter((item) => Boolean(item.is_artwork))
  const artworkById = new Map(existingArtwork.map((item) => [item.id, item]))
  const artworkByPhotoId = new Map(
    existingArtwork.filter((item) => item.facebook_photo_id)
      .map((item) => [String(item.facebook_photo_id), item])
  )
  const artworkByTargetUrl = new Map(
    existingArtwork.filter((item) => item.target_url)
      .map((item) => [item.target_url, item])
  )
  const artworkByImageUrl = new Map(
    existingArtwork.filter((item) => item.image_url)
      .map((item) => [item.image_url, item])
  )
  const artworkBySortIndex = new Map(existingArtwork.map((item) => [item.sort_index, item]))
  const now = Date.now()
  const stored = products.map((product, index) => {
    const id = `${post.id}-${String(index + 1).padStart(2, '0')}`
    const matchedArtwork = (
      (product.facebookPhotoId && artworkByPhotoId.get(String(product.facebookPhotoId))) ||
      (product.targetUrl && artworkByTargetUrl.get(product.targetUrl)) ||
      (product.imageUrl && artworkByImageUrl.get(product.imageUrl)) ||
      artworkById.get(id) ||
      artworkBySortIndex.get(index)
    )
    return {
      ...product,
      id,
      postId: post.id,
      postCreatedTime: post.createdTime || '',
      isArtwork: Boolean(matchedArtwork)
    }
  })

  const statements = [
    env.DB.prepare(`
      INSERT INTO posts (id, page_id, message, permalink_url, created_time, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        message = excluded.message,
        permalink_url = excluded.permalink_url,
        created_time = excluded.created_time,
        updated_at = excluded.updated_at
    `).bind(post.id, connection.pageId, post.message || '', post.permalinkUrl || '', post.createdTime || '', now),
    env.DB.prepare('DELETE FROM products WHERE page_id = ? AND post_id = ?')
      .bind(connection.pageId, post.id)
  ]

  for (let index = 0; index < stored.length; index += 1) {
    const product = stored[index]
    statements.push(env.DB.prepare(`
      INSERT INTO products (
        id, post_id, page_id, facebook_photo_id, image_url, width, height,
        target_url, caption, original_caption, sold, is_artwork, sort_index, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      product.id,
      post.id,
      connection.pageId,
      product.facebookPhotoId || null,
      product.imageUrl,
      product.width || null,
      product.height || null,
      product.targetUrl || null,
      product.caption || '',
      product.originalCaption || '',
      product.sold ? 1 : 0,
      product.isArtwork ? 1 : 0,
      index,
      now
    ))
  }

  await runBatches(env.DB, statements)
  return stored
}

async function fetchAndStoreFacebookPost(request, env, connection) {
  const { postId, skipExisting = false } = await readJson(request)
  if (!postId?.trim()) return json({ error: 'กรุณาระบุ Facebook Post ID' }, 400)

  const resolvedPostId = await resolvePostId(postId, connection)
  if (skipExisting) {
    const existing = await env.DB.prepare('SELECT id FROM posts WHERE id = ? AND page_id = ?')
      .bind(resolvedPostId, connection.pageId).first()
    if (existing) return json({ error: 'โพสต์นี้ถูกนำเข้าแล้ว', code: 'ALREADY_IMPORTED' }, 409)
  }

  const fields = 'id,message,permalink_url,created_time,attachments.limit(100){description,title,media_type,media,target,url,subattachments.limit(100){description,title,media_type,media,target,url}}'
  const endpoint = new URL(`https://graph.facebook.com/${graphVersion(env, connection)}/${encodeURIComponent(resolvedPostId)}`)
  endpoint.searchParams.set('fields', fields)
  endpoint.searchParams.set('access_token', connection.accessToken)

  const response = await fetch(endpoint)
  const data = await response.json()
  if (!response.ok) {
    return json({
      error: data?.error?.message || 'Facebook Graph API error',
      code: data?.error?.code || 'FACEBOOK_ERROR'
    }, response.status)
  }

  const post = {
    id: data.id,
    message: data.message || '',
    permalinkUrl: data.permalink_url || '',
    createdTime: data.created_time || ''
  }
  const fetchedProducts = await addPhotoCaptions(
    extractImages(data.attachments?.data),
    graphVersion(env, connection),
    connection.accessToken
  )
  const products = await saveImportedPost(env, connection, post, fetchedProducts)
  return json({ post, products })
}

async function listFacebookPosts(request, env, connection) {
  const requestUrl = new URL(request.url)
  const after = requestUrl.searchParams.get('after') || ''
  if (after.length > 8_000) return json({ error: 'Facebook cursor ไม่ถูกต้อง' }, 400)

  const fields = 'id,message,permalink_url,created_time,attachments.limit(10){description,title,media_type,media,target,url,subattachments.limit(10){description,title,media_type,media,target,url}}'
  const endpoint = new URL(`https://graph.facebook.com/${graphVersion(env, connection)}/${encodeURIComponent(connection.pageId)}/posts`)
  endpoint.searchParams.set('fields', fields)
  endpoint.searchParams.set('limit', '10')
  endpoint.searchParams.set('access_token', connection.accessToken)
  if (after) endpoint.searchParams.set('after', after)

  const response = await fetch(endpoint)
  const data = await response.json()
  if (!response.ok) {
    return json({
      error: data?.error?.message || 'ดึงรายการโพสต์จาก Facebook ไม่สำเร็จ',
      code: data?.error?.code || 'FACEBOOK_ERROR'
    }, response.status)
  }

  const facebookPosts = Array.isArray(data.data) ? data.data : []
  const postIds = facebookPosts.map((post) => String(post.id)).filter(Boolean)
  let importedIds = new Set()

  if (postIds.length > 0) {
    const placeholders = postIds.map(() => '?').join(', ')
    const imported = await env.DB.prepare(`
      SELECT id FROM posts
      WHERE page_id = ? AND id IN (${placeholders})
    `).bind(connection.pageId, ...postIds).all()
    importedIds = new Set((imported.results || []).map((post) => String(post.id)))
  }

  const posts = facebookPosts
    .map((post) => ({
      id: String(post.id),
      message: post.message || '',
      permalinkUrl: post.permalink_url || '',
      createdTime: post.created_time || '',
      imported: importedIds.has(String(post.id)),
      images: extractImages(post.attachments?.data).slice(0, 3).map((image) => ({
        imageUrl: image.imageUrl,
        targetUrl: image.targetUrl
      }))
    }))
    .filter((post) => post.images.length > 0)

  let nextAfter = data.paging?.cursors?.after || null
  if (!nextAfter && data.paging?.next) {
    try {
      nextAfter = new URL(data.paging.next).searchParams.get('after')
    } catch {}
  }

  return json({
    posts,
    paging: {
      after: nextAfter,
      hasNext: Boolean(nextAfter)
    }
  })
}

async function listProducts(env, connection) {
  const result = await env.DB.prepare(`
    SELECT p.*, posts.created_time
    FROM products p
    JOIN posts ON posts.id = p.post_id
    WHERE p.page_id = ?
    ORDER BY posts.created_time DESC, p.sort_index ASC
  `).bind(connection.pageId).all()
  return json({ products: (result.results || []).map(rowToProduct) })
}

async function getPageSettings(env, pageId) {
  const settings = await env.DB.prepare(`
    SELECT description, theme_color
    FROM page_settings
    WHERE page_id = ?
  `).bind(pageId).first()
  return {
    description: settings?.description || '',
    themeColor: settings?.theme_color || '#256f4a'
  }
}

async function updatePageSettings(request, env, connection) {
  const body = await readJson(request)
  const description = typeof body.description === 'string' ? body.description.trim() : ''
  const themeColor = typeof body.themeColor === 'string' ? body.themeColor.trim() : ''

  if (description.length > 2_000) return json({ error: 'รายละเอียดต้องไม่เกิน 2,000 ตัวอักษร' }, 400)
  if (!/^#[0-9a-f]{6}$/i.test(themeColor)) return json({ error: 'Theme color ไม่ถูกต้อง' }, 400)

  await env.DB.prepare(`
    INSERT INTO page_settings (page_id, description, theme_color, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(page_id) DO UPDATE SET
      description = excluded.description,
      theme_color = excluded.theme_color,
      updated_at = excluded.updated_at
  `).bind(connection.pageId, description, themeColor, Date.now()).run()

  return json({ ok: true, settings: { description, themeColor } })
}

async function sendMessengerProduct(env, pageId, recipientId, productId) {
  const connection = await env.DB.prepare(`
    SELECT access_token_cipher, graph_version
    FROM page_connections
    WHERE page_id = ?
  `).bind(pageId).first()
  if (!connection) return

  const product = await env.DB.prepare(`
    SELECT image_url
    FROM products
    WHERE page_id = ? AND id = ? AND is_artwork = 0
  `).bind(pageId, productId).first()
  if (!product) return

  const endpoint = `https://graph.facebook.com/${connection.graph_version || graphVersion(env)}/${pageId}/messages`
  const accessToken = await decryptText(connection.access_token_cipher, env)
  const sendPayload = async (payload) => {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        recipient: { id: recipientId },
        ...payload
      })
    })
    if (!response.ok) {
      const data = await response.json().catch(() => ({}))
      throw new Error(data?.error?.message || 'ส่งสินค้าเข้า Messenger ไม่สำเร็จ')
    }
  }
  const sendMessage = (message) => sendPayload({ message_type: 'RESPONSE', message })

  await sendMessage({ text: 'รับคำขอแล้ว กำลังส่งรูปสินค้าให้นะคะ…' })
  await sendPayload({ sender_action: 'typing_on' }).catch(() => {})
  try {
    await sendMessage({
      attachment: {
        type: 'image',
        payload: { url: product.image_url }
      }
    })
  } finally {
    await sendPayload({ sender_action: 'typing_off' }).catch(() => {})
  }
  await sendMessage({ text: 'สนใจสินค้าชิ้นนี้ไหมคะ?' })
}

async function processMessengerWebhook(env, payload) {
  if (payload.object !== 'page') return

  for (const entry of payload.entry || []) {
    const pageId = String(entry.id || '')
    for (const event of entry.messaging || []) {
      const referral = event.referral || event.postback?.referral || event.message?.referral
      const ref = referral?.ref || ''
      if (!pageId || !event.sender?.id || !ref.startsWith('product-')) continue
      await sendMessengerProduct(env, pageId, event.sender.id, ref.slice('product-'.length))
    }
  }
}

async function handleMessengerWebhook(request, env, context) {
  const url = new URL(request.url)
  if (request.method === 'GET') {
    const valid = url.searchParams.get('hub.mode') === 'subscribe'
      && url.searchParams.get('hub.verify_token') === env.MESSENGER_VERIFY_TOKEN
    return new Response(valid ? url.searchParams.get('hub.challenge') || '' : 'Forbidden', {
      status: valid ? 200 : 403
    })
  }

  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 })
  const body = await request.text()
  const valid = await verifyWebhookSignature(
    body,
    request.headers.get('X-Hub-Signature-256'),
    env.FACEBOOK_APP_SECRET
  )
  if (!valid) return new Response('Invalid signature', { status: 403 })

  const payload = JSON.parse(body || '{}')
  context.waitUntil(processMessengerWebhook(env, payload).catch(console.error))
  return new Response('EVENT_RECEIVED')
}

async function downloadPublicStockImage(env, pageId, productId) {
  const product = await env.DB.prepare(`
    SELECT image_url
    FROM products
    WHERE page_id = ? AND id = ? AND sold = 0 AND is_artwork = 0
  `).bind(pageId, productId).first()
  if (!product) return new Response('ไม่พบรูปสินค้า', { status: 404 })

  const imageResponse = await fetch(product.image_url)
  if (!imageResponse.ok) return new Response('ดาวน์โหลดรูปสินค้าไม่สำเร็จ', { status: 502 })

  const contentType = imageResponse.headers.get('Content-Type') || 'image/jpeg'
  const extension = contentType.includes('png') ? 'png' : contentType.includes('webp') ? 'webp' : 'jpg'
  const filename = String(productId).replace(/[^a-z0-9._-]/gi, '-') || 'product'
  return new Response(imageResponse.body, {
    headers: {
      'Content-Type': contentType,
      'Content-Disposition': `attachment; filename="${filename}.${extension}"`,
      'Cache-Control': 'public, max-age=3600',
      'X-Content-Type-Options': 'nosniff'
    }
  })
}

function formatPostSectionDate(value) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return { date: 'ไม่ระบุวันที่', daysAgo: '' }

  const dateParts = Object.fromEntries(new Intl.DateTimeFormat('en', {
    timeZone: 'Asia/Bangkok',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric'
  }).formatToParts(date).map((part) => [part.type, part.value]))
  const todayParts = Object.fromEntries(new Intl.DateTimeFormat('en', {
    timeZone: 'Asia/Bangkok',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric'
  }).formatToParts(new Date()).map((part) => [part.type, part.value]))
  const postDay = Date.UTC(Number(dateParts.year), Number(dateParts.month) - 1, Number(dateParts.day))
  const today = Date.UTC(Number(todayParts.year), Number(todayParts.month) - 1, Number(todayParts.day))
  const daysAgo = Math.max(0, Math.floor((today - postDay) / 86_400_000))
  return {
    date: `${dateParts.day}/${dateParts.month}/${dateParts.year}`,
    daysAgo: `(${daysAgo} วันที่แล้ว)`
  }
}

async function renderPublicStocks(env, pageId, postId = '', section = '') {
  const page = await env.DB.prepare(`
    SELECT page_id, page_name
    FROM page_connections
    WHERE page_id = ?
  `).bind(pageId).first()

  if (!page) {
    return new Response('ไม่พบหน้าร้าน', {
      status: 404,
      headers: { 'Content-Type': 'text/plain; charset=UTF-8' }
    })
  }

  if (postId) {
    const post = await env.DB.prepare(`
      SELECT id FROM posts WHERE page_id = ? AND id = ?
    `).bind(pageId, postId).first()
    if (!post) {
      return new Response('ไม่พบโพสต์', {
        status: 404,
        headers: { 'Content-Type': 'text/plain; charset=UTF-8' }
      })
    }
  }

  const postFilter = postId ? ' AND p.post_id = ?' : ''
  const query = env.DB.prepare(`
    SELECT p.id, p.post_id, p.facebook_photo_id, p.image_url, p.width, p.height,
      p.target_url, p.caption, posts.created_time, posts.message AS post_message,
      COUNT(*) OVER (PARTITION BY p.post_id) AS post_product_count,
      (
        SELECT artwork.image_url
        FROM products artwork
        WHERE artwork.post_id = p.post_id AND artwork.is_artwork = 1
        ORDER BY artwork.sort_index ASC
        LIMIT 1
      ) AS artwork_image_url
    FROM products p
    JOIN posts ON posts.id = p.post_id
    WHERE p.page_id = ? AND p.sold = 0 AND p.is_artwork = 0${postFilter}
    ORDER BY posts.created_time DESC, p.sort_index ASC
  `)
  const result = await (postId ? query.bind(pageId, postId) : query.bind(pageId)).all()
  const products = result.results || []
  const settings = await getPageSettings(env, pageId)
  const groupByPost = section === 'post'
  let previousPostId = ''
  let postSectionIndex = 0
  const cards = products.map((product) => {
    const ratioStyle = product.width > 0 && product.height > 0
      ? ` style="aspect-ratio: ${Number(product.width)} / ${Number(product.height)}"`
      : ''
    const image = `<img src="${escapeHtml(product.image_url)}" alt="${escapeHtml(product.caption || product.id)}" loading="lazy">`
    const messengerUrl = `https://m.me/${encodeURIComponent(pageId)}?ref=${encodeURIComponent(`product-${product.id}`)}`
    const productUrl = product.facebook_photo_id
      ? `https://www.facebook.com/${encodeURIComponent(pageId)}/photos/${encodeURIComponent(product.facebook_photo_id)}/`
      : product.target_url || ''
    const downloadUrl = `/${encodeURIComponent(pageId)}/stocks/image/${encodeURIComponent(product.id)}`
    const media = `<button class="stock-image" type="button"${ratioStyle} data-image-url="${escapeHtml(product.image_url)}" data-image-alt="${escapeHtml(product.caption || product.id)}" data-post-url="${escapeHtml(productUrl)}" data-messenger-url="${escapeHtml(messengerUrl)}" data-download-url="${escapeHtml(downloadUrl)}" data-download-name="${escapeHtml(product.id)}">${image}</button>`
    const isNewPost = groupByPost && product.post_id !== previousPostId
    const postMessage = String(product.post_message || '')
    const descriptionId = `post-description-${postSectionIndex}`
    const artwork = product.artwork_image_url
      ? `<img class="post-artwork" src="${escapeHtml(product.artwork_image_url)}" alt="Artwork ของโพสต์" loading="lazy">`
      : ''
    const description = postMessage
      ? `<div class="post-description-wrap"><div id="${descriptionId}" class="post-description">${renderMarkdownLinks(postMessage)}</div><button class="post-description-toggle" type="button" aria-expanded="false" aria-controls="${descriptionId}">ดูทั้งหมด</button></div>`
      : ''
    const sectionDate = formatPostSectionDate(product.created_time)
    const sectionHeader = isNewPost
      ? `<div class="post-section${artwork ? '' : ' no-artwork'}">${artwork}<div class="post-section-content"><h2 class="post-date">${escapeHtml(sectionDate.date)} <span class="post-count">${Number(product.post_product_count) || 0} รายการ</span><span class="post-days">${escapeHtml(sectionDate.daysAgo)}</span></h2>${description}</div></div>`
      : ''
    if (isNewPost) postSectionIndex += 1
    previousPostId = product.post_id
    return `${sectionHeader}<article class="stock-card">${media}<div class="stock-detail"><strong>${escapeHtml(product.id)}</strong><span>พร้อมขาย</span></div></article>`
  }).join('')
  const content = cards || '<div class="empty"><div>□</div><h2>ยังไม่มีสินค้าพร้อมขาย</h2><p>โปรดกลับมาตรวจสอบอีกครั้งภายหลัง</p></div>'
  const pageName = escapeHtml(page.page_name)
  const description = settings.description
    ? `<div class="page-description">${renderMarkdownLinks(settings.description)}</div>`
    : ''
  const themeColor = escapeHtml(settings.themeColor)

  return new Response(`<!doctype html>
<html lang="th">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="description" content="สินค้าพร้อมขายจาก ${pageName}">
    <title>${pageName} — สินค้าพร้อมขาย</title>
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;600;700&family=Noto+Sans+Thai:wght@400;600;700&display=swap" rel="stylesheet">
    <style>
      :root { color-scheme: light; --ink: #17211b; --muted: #718078; --line: #e5eae6; --paper: #fff; --canvas: #f5f7f5; --green: ${themeColor}; --green-soft: color-mix(in srgb, var(--green) 12%, white); }
      * { box-sizing: border-box; }
      body { margin: 0; min-width: 320px; color: var(--ink); background: var(--canvas); font-family: "DM Sans", "Noto Sans Thai", sans-serif; }
      header, main { width: min(1180px, calc(100% - 36px)); margin-inline: auto; }
      header { display: flex; align-items: end; justify-content: space-between; gap: 24px; padding: 54px 0 18px; }
      .eyebrow { margin: 0 0 7px; color: var(--green); font-size: 11px; font-weight: 700; letter-spacing: .16em; }
      h1 { margin: 0; font-size: clamp(28px, 5vw, 48px); letter-spacing: -.04em; }
      .header-actions { display: flex; flex: none; align-items: center; gap: 8px; }
      .count { display: inline-flex; height: 40px; flex: none; align-items: center; justify-content: center; padding: 0 16px; border-radius: 999px; color: var(--green); background: var(--green-soft); font-size: 13px; font-weight: 700; white-space: nowrap; }
      .section-filter { height: 40px; padding: 0 16px; border: 1px solid var(--line); border-radius: 999px; appearance: none; -webkit-appearance: none; color: var(--ink); background-color: var(--paper); font: inherit; font-size: 12px; font-weight: 700; line-height: 40px; cursor: pointer; }
      .page-description { max-width: 760px; margin: 0 0 28px; color: var(--muted); font-size: 14px; line-height: 1.75; }
      .page-description a { color: var(--green); font-weight: 700; text-underline-offset: 3px; }
      main { padding-bottom: 64px; }
      .stock-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); align-items: start; gap: 18px; }
      .post-section { display: grid; grid-column: 1 / -1; grid-template-columns: 70px minmax(0, 1fr); align-items: start; gap: 12px; margin: 18px 0 0; }
      .post-section:first-child { margin-top: 0; }
      .post-section.no-artwork { grid-template-columns: 1fr; }
      .post-section-content { min-width: 0; }
      .post-date { margin: 0; color: var(--muted); font-size: 13px; font-weight: 700; line-height: 1.4; }
      .post-count { display: inline-flex; align-items: center; margin-left: 5px; padding: 2px 7px; border-radius: 999px; color: var(--green); background: var(--green-soft); font-size: 10px; line-height: 1.4; }
      .post-days { display: block; }
      .post-artwork { display: block; width: 70px; height: auto; max-height: 120px; border-radius: 7px; object-fit: contain; object-position: top; }
      .post-description-wrap { min-width: 0; margin-top: 8px; }
      .post-description { overflow: hidden; color: var(--muted); font-size: 13px; line-height: 1.7; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 3; }
      .post-description.expanded { display: block; overflow: visible; }
      .post-description a { color: var(--green); font-weight: 700; }
      .post-description-toggle { margin-top: 8px; padding: 0; border: 0; color: var(--green); background: transparent; font: inherit; font-size: 12px; font-weight: 700; cursor: pointer; }
      .stock-card { overflow: hidden; border: 1px solid var(--line); border-radius: 13px; background: var(--paper); box-shadow: 0 7px 24px rgb(23 33 27 / 5%); }
      .stock-image { display: block; width: 100%; aspect-ratio: 1; overflow: hidden; padding: 0; border: 0; background: #edf0ed; cursor: zoom-in; }
      .stock-image img { width: 100%; height: 100%; object-fit: cover; transition: transform .2s ease; }
      .stock-image:hover img { transform: scale(1.025); }
      .stock-image:focus-visible { outline: 3px solid var(--green); outline-offset: -3px; }
      .stock-detail { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 13px; }
      .stock-detail strong { overflow: hidden; font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
      .stock-detail span { flex: none; color: var(--green); font-size: 10px; font-weight: 700; }
      .empty { grid-column: 1 / -1; padding: 100px 20px; border: 1px dashed var(--line); border-radius: 13px; color: var(--muted); background: var(--paper); text-align: center; }
      .empty div { font-size: 36px; } .empty h2 { margin: 12px 0 0; color: var(--ink); font-size: 18px; } .empty p { margin: 6px 0 0; font-size: 13px; }
      dialog { width: min(920px, calc(100% - 24px)); max-height: calc(100vh - 24px); padding: 0; border: 0; border-radius: 16px; background: var(--paper); box-shadow: 0 30px 90px rgb(13 32 21 / 35%); }
      dialog::backdrop { background: rgb(15 28 20 / 72%); backdrop-filter: blur(4px); }
      .preview-body { display: grid; max-height: calc(100vh - 24px); }
      .preview-image-wrap { display: grid; min-height: 240px; max-height: calc(100vh - 112px); place-items: center; overflow: hidden; background: #edf0ed; }
      .preview-image { display: block; max-width: 100%; max-height: calc(100vh - 112px); object-fit: contain; }
      .preview-actions { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; padding: 14px; }
      .preview-actions a, .preview-actions button { display: flex; align-items: center; justify-content: center; gap: 8px; min-height: 42px; padding: 10px 14px; border: 0; border-radius: 9px; font: inherit; font-size: 13px; font-weight: 700; text-align: center; cursor: pointer; }
      .preview-actions svg { flex: none; width: 20px; height: 20px; fill: currentColor; }
      .preview-close { grid-column: 1 / -1; color: var(--muted); background: var(--canvas); }
      .post-link { color: white; background: var(--green); text-decoration: none; }
      .copy-post { color: var(--green); background: var(--green-soft); }
      .save-image { grid-column: 1 / -1; color: white; background: var(--green); text-decoration: none; }
      .post-link[hidden], .copy-post[hidden] { display: none; }
      .post-link[hidden] + .copy-post { grid-column: 1 / -1; }
      @media (max-width: 900px) { .stock-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); } }
      @media (max-width: 620px) { header { align-items: flex-start; flex-direction: column; padding-top: 36px; } .header-actions { width: 100%; } .section-filter { min-width: 0; flex: 1; } .stock-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; } .stock-detail { align-items: flex-start; flex-direction: column; } }
    </style>
  </head>
  <body>
    <header>
      <div><p class="eyebrow">AVAILABLE STOCK</p><h1>${pageName}</h1></div>
      <div class="header-actions">
        <select class="section-filter" aria-label="รูปแบบการแสดงสินค้า">
          <option value=""${groupByPost ? '' : ' selected'}>แสดงทั้งหมด</option>
          <option value="post"${groupByPost ? ' selected' : ''}>แสดงแยกโพสต์</option>
        </select>
        <span class="count">${products.length} รายการ</span>
      </div>
    </header>
    <main>${description}<section class="stock-grid" aria-label="สินค้าพร้อมขาย">${content}</section></main>
    <dialog id="productPreview" aria-label="รูปสินค้าแบบเต็ม">
      <div class="preview-body">
        <div class="preview-image-wrap"><img class="preview-image" alt=""></div>
        <div class="preview-actions">
          <a class="post-link" target="_blank" rel="noopener noreferrer">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M24 12.07C24 5.4 18.63 0 12 0S0 5.4 0 12.07C0 18.1 4.39 23.1 10.13 24v-8.44H7.08v-3.49h3.05V9.41c0-3.03 1.79-4.7 4.53-4.7 1.31 0 2.68.24 2.68.24v2.96h-1.51c-1.49 0-1.96.93-1.96 1.89v2.27h3.33l-.53 3.49h-2.8V24C19.61 23.1 24 18.1 24 12.07Z"/></svg>
            <span>Facebook</span>
          </a>
          <a class="copy-post" target="_blank" rel="noopener noreferrer">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2C6.48 2 2 6.15 2 11.27c0 2.92 1.46 5.53 3.74 7.23V22l3.42-1.88c.9.25 1.86.39 2.84.39 5.52 0 10-4.15 10-9.24S17.52 2 12 2Zm.99 12.48-2.54-2.71-4.96 2.71 5.45-5.79 2.61 2.71 4.89-2.71-5.45 5.79Z"/></svg>
            <span>Messenger</span>
          </a>
          <button class="save-image" type="button">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M11 3h2v10.17l3.59-3.58L18 11l-6 6-6-6 1.41-1.41L11 13.17V3Zm-6 16h14v2H5v-2Z"/></svg>
            <span>บันทึกรูปภาพ</span>
          </button>
          <button class="preview-close" type="button">ปิด</button>
        </div>
      </div>
    </dialog>
    <script>
      const preview = document.querySelector('#productPreview')
      const previewImage = preview.querySelector('.preview-image')
      const postLink = preview.querySelector('.post-link')
      const copyPost = preview.querySelector('.copy-post')
      const saveImage = preview.querySelector('.save-image')
      const isFacebookApp = /FBAN|FBAV|FB_IAB|FBIOS|FB4A|MessengerForiOS/i.test(navigator.userAgent)
      let preparedImageFile = null

      document.querySelector('.section-filter').addEventListener('change', (event) => {
        const url = new URL(window.location.href)
        if (event.target.value) url.searchParams.set('section', event.target.value)
        else url.searchParams.delete('section')
        window.location.href = url.toString()
      })
      document.querySelectorAll('.post-description-toggle').forEach((button) => {
        const description = document.getElementById(button.getAttribute('aria-controls'))
        if (description.scrollHeight <= description.clientHeight) button.hidden = true
        button.addEventListener('click', () => {
          const expanded = !description.classList.contains('expanded')
          description.classList.toggle('expanded', expanded)
          button.setAttribute('aria-expanded', String(expanded))
          button.textContent = expanded ? 'ย่อ' : 'ดูทั้งหมด'
        })
      })

      document.querySelectorAll('.stock-image').forEach((button) => {
        button.addEventListener('click', () => {
          previewImage.src = button.dataset.imageUrl
          previewImage.alt = button.dataset.imageAlt
          postLink.hidden = isFacebookApp || !button.dataset.postUrl
          copyPost.href = button.dataset.messengerUrl
          saveImage.dataset.downloadUrl = button.dataset.downloadUrl
          saveImage.dataset.downloadName = button.dataset.downloadName
          saveImage.disabled = true
          saveImage.querySelector('span').textContent = 'กำลังเตรียมรูป…'
          preparedImageFile = null
          const downloadUrl = button.dataset.downloadUrl
          fetch(downloadUrl).then(async (response) => {
            if (!response.ok) throw new Error('download failed')
            const blob = await response.blob()
            if (saveImage.dataset.downloadUrl !== downloadUrl) return
            const extension = blob.type.includes('png') ? 'png' : blob.type.includes('webp') ? 'webp' : 'jpg'
            const name = (button.dataset.downloadName || 'product').replace(/[^a-z0-9._-]/gi, '-')
            preparedImageFile = new File([blob], name + '.' + extension, { type: blob.type || 'image/jpeg' })
            saveImage.disabled = false
            saveImage.querySelector('span').textContent = 'บันทึกรูปภาพ'
          }).catch(() => {
            if (saveImage.dataset.downloadUrl !== downloadUrl) return
            saveImage.querySelector('span').textContent = 'เตรียมรูปไม่สำเร็จ'
          })
          if (button.dataset.postUrl) postLink.href = button.dataset.postUrl
          else postLink.removeAttribute('href')
          preview.showModal()
        })
      })
      saveImage.addEventListener('click', async () => {
        if (!preparedImageFile) return
        try {
          if (navigator.canShare && navigator.canShare({ files: [preparedImageFile] })) {
            await navigator.share({ files: [preparedImageFile] })
          } else {
            const blobUrl = URL.createObjectURL(preparedImageFile)
            const link = document.createElement('a')
            link.href = blobUrl
            link.download = preparedImageFile.name
            document.body.append(link)
            link.click()
            link.remove()
            setTimeout(() => URL.revokeObjectURL(blobUrl), 1000)
          }
        } catch (error) {
          if (error.name !== 'AbortError') alert('บันทึกรูปภาพไม่สำเร็จ กรุณาลองอีกครั้ง')
        }
      })
      preview.querySelector('.preview-close').addEventListener('click', () => preview.close())
      preview.addEventListener('click', (event) => {
        if (event.target === preview) preview.close()
      })
      preview.addEventListener('close', () => {
        previewImage.removeAttribute('src')
      })
    </script>
  </body>
</html>`, {
    headers: {
      'Content-Type': 'text/html; charset=UTF-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'strict-origin-when-cross-origin'
    }
  })
}

async function updateProduct(request, env, connection, productId) {
  const body = await readJson(request)
  const updates = []
  const values = []

  if (typeof body.sold === 'boolean') {
    updates.push('sold = ?')
    values.push(body.sold ? 1 : 0)
  }
  if (typeof body.isArtwork === 'boolean') {
    updates.push('is_artwork = ?')
    values.push(body.isArtwork ? 1 : 0)
  }
  if (updates.length === 0) return json({ error: 'ไม่มีข้อมูลที่ต้องแก้ไข' }, 400)

  updates.push('updated_at = ?')
  values.push(Date.now(), productId, connection.pageId)
  const result = await env.DB.prepare(`
    UPDATE products SET ${updates.join(', ')} WHERE id = ? AND page_id = ?
  `).bind(...values).run()
  if (!result.meta.changes) return json({ error: 'ไม่พบสินค้า' }, 404)
  return json({ ok: true })
}

async function fetchPostImages(postIds, version, token) {
  const imagesByPostId = new Map()
  const uniquePostIds = [...new Set(postIds.filter(Boolean))]
  const fields = 'attachments.limit(100){description,title,media_type,media,target,url,subattachments.limit(100){description,title,media_type,media,target,url}}'

  for (let index = 0; index < uniquePostIds.length; index += 25) {
    const chunk = uniquePostIds.slice(index, index + 25)
    const endpoint = new URL(`https://graph.facebook.com/${version}/`)
    endpoint.searchParams.set('ids', chunk.join(','))
    endpoint.searchParams.set('fields', fields)
    endpoint.searchParams.set('access_token', token)

    try {
      const response = await fetch(endpoint)
      const data = await response.json()
      if (!response.ok) continue

      for (const postId of chunk) {
        const postData = data[String(postId)]
        if (!postData || postData.error) continue
        imagesByPostId.set(String(postId), extractImages(postData.attachments?.data))
      }
    } catch {}
  }

  return imagesByPostId
}

async function syncFacebookPhotos(request, env, connection) {
  const { photoIds, postIds } = await readJson(request)
  const uniquePhotoIds = [...new Set(
    (Array.isArray(photoIds) ? photoIds : []).filter((photoId) => /^\d+$/.test(String(photoId)))
  )]
  const uniquePostIds = [...new Set(
    (Array.isArray(postIds) ? postIds : []).filter((postId) => /^\d+_\d+$/.test(String(postId)))
  )]
  if (uniquePhotoIds.length === 0 && uniquePostIds.length === 0) return json({ items: [] })
  if (uniquePhotoIds.length > 500) return json({ error: 'Sync ได้สูงสุด 500 รูปต่อครั้ง' }, 400)
  if (uniquePostIds.length > 25) return json({ error: 'Sync ได้สูงสุด 25 โพสต์ต่อครั้ง' }, 400)

  const filters = []
  const values = [connection.pageId]
  if (uniquePhotoIds.length > 0) {
    filters.push(`facebook_photo_id IN (${uniquePhotoIds.map(() => '?').join(', ')})`)
    values.push(...uniquePhotoIds)
  }
  if (uniquePostIds.length > 0) {
    filters.push(`post_id IN (${uniquePostIds.map(() => '?').join(', ')})`)
    values.push(...uniquePostIds)
  }
  const storedProducts = await env.DB.prepare(`
    SELECT id, facebook_photo_id, post_id, image_url, target_url, sort_index,
      caption, original_caption, sold
    FROM products
    WHERE page_id = ? AND is_artwork = 0 AND (${filters.join(' OR ')})
    ORDER BY post_id, sort_index
  `).bind(...values).all()
  const products = (storedProducts.results || []).map((product) => ({
    id: product.id,
    facebookPhotoId: product.facebook_photo_id ? String(product.facebook_photo_id) : null,
    postId: product.post_id,
    imageUrl: product.image_url,
    targetUrl: product.target_url,
    sortIndex: product.sort_index,
    caption: product.caption || '',
    originalCaption: product.original_caption || '',
    sold: Boolean(product.sold)
  }))
  const imagesByPostId = await fetchPostImages(
    products.map((product) => product.postId),
    graphVersion(env, connection),
    connection.accessToken
  )

  for (const product of products) {
    const postImages = imagesByPostId.get(String(product.postId))
    if (!postImages) continue
    const matchedImage = postImages.find((image) => (
      image.facebookPhotoId && image.facebookPhotoId === product.facebookPhotoId
    )) || postImages.find((image) => (
      image.targetUrl && image.targetUrl === product.targetUrl
    )) || postImages[product.sortIndex]
    if (!matchedImage) continue

    product.facebookPhotoId = matchedImage.facebookPhotoId || null
    product.attachmentCaption = matchedImage.attachmentCaption || ''
    product.attachmentCaptionResolved = true
  }

  const synced = await addPhotoCaptions(products, graphVersion(env, connection), connection.accessToken)
  const now = Date.now()
  const resolved = synced.filter((item) => item.captionResolved)
  await runBatches(env.DB, resolved.map((item) => env.DB.prepare(`
    UPDATE products
    SET facebook_photo_id = ?, caption = ?, original_caption = ?, sold = ?, updated_at = ?
    WHERE id = ? AND page_id = ?
  `).bind(
    item.facebookPhotoId || null,
    item.caption || '',
    item.originalCaption || item.caption || '',
    item.sold ? 1 : 0,
    now,
    item.id,
    connection.pageId
  )))
  return json({
    items: synced.map(({ id, facebookPhotoId, caption, sold, captionResolved }) => ({
      id,
      facebookPhotoId,
      caption,
      sold,
      captionResolved
    })),
    updated: resolved.length,
    skipped: synced.length - resolved.length
  })
}

async function configureFacebook(request, env) {
  const { accessToken, version } = await readJson(request)
  if (!accessToken?.trim()) return json({ error: 'กรุณากรอก Page Access Token' }, 400)

  const selectedVersion = version?.trim() || graphVersion(env)
  if (!/^v\d+\.\d+$/.test(selectedVersion)) {
    return json({ error: 'Graph API version ต้องมีรูปแบบ เช่น v26.0' }, 400)
  }

  const endpoint = new URL(`https://graph.facebook.com/${selectedVersion}/me`)
  endpoint.searchParams.set('fields', 'id,name,category')
  endpoint.searchParams.set('access_token', accessToken.trim())
  const response = await fetch(endpoint)
  const data = await response.json()

  if (!response.ok) return json({ error: data?.error?.message || 'ตรวจสอบ Facebook token ไม่สำเร็จ' }, response.status)
  if (!data.category) {
    return json({ error: 'Token นี้เป็น User Access Token กรุณาใช้ Page Access Token' }, 400)
  }

  const page = { ...data, access_token: accessToken.trim() }
  await saveConnection(env, page, selectedVersion)
  const sessionId = await createSession(env, page.id)
  return json(
    { ok: true, profile: { id: page.id, name: page.name, category: page.category }, version: selectedVersion },
    200,
    { 'Set-Cookie': sessionCookie(request, sessionId) }
  )
}

async function fetchGraphCollection(url, fallbackError) {
  const items = []
  let nextUrl = url.toString()

  while (nextUrl) {
    const response = await fetch(nextUrl)
    const data = await response.json()
    if (!response.ok) throw new Error(data?.error?.message || fallbackError)
    items.push(...(data.data || []))
    nextUrl = data.paging?.next || ''
  }

  return items
}

async function fetchFacebookPages(version, userToken) {
  const pagesById = new Map()
  const addPages = (pages) => {
    for (const page of pages) {
      if (page.id && page.access_token) pagesById.set(String(page.id), page)
    }
  }

  const pagesUrl = new URL(`https://graph.facebook.com/${version}/me/accounts`)
  pagesUrl.searchParams.set('fields', 'id,name,category,access_token,tasks')
  pagesUrl.searchParams.set('limit', '100')
  pagesUrl.searchParams.set('access_token', userToken)
  addPages(await fetchGraphCollection(pagesUrl, 'ดึงรายการ Page ไม่สำเร็จ'))

  try {
    const businessesUrl = new URL(`https://graph.facebook.com/${version}/me/businesses`)
    businessesUrl.searchParams.set('fields', 'id,name')
    businessesUrl.searchParams.set('limit', '100')
    businessesUrl.searchParams.set('access_token', userToken)
    const businesses = await fetchGraphCollection(businessesUrl, 'ดึงรายการ Business Portfolio ไม่สำเร็จ')

    const results = await Promise.allSettled(businesses.map(async (business) => {
      const ownedPagesUrl = new URL(`https://graph.facebook.com/${version}/${encodeURIComponent(business.id)}/owned_pages`)
      ownedPagesUrl.searchParams.set('fields', 'id,name,category,access_token,tasks')
      ownedPagesUrl.searchParams.set('limit', '100')
      ownedPagesUrl.searchParams.set('access_token', userToken)
      return fetchGraphCollection(ownedPagesUrl, `ดึง Page จาก ${business.name || 'Business Portfolio'} ไม่สำเร็จ`)
    }))

    for (const result of results) {
      if (result.status === 'fulfilled') addPages(result.value)
    }
  } catch {
    // Accounts without business_management can still use Pages returned by /me/accounts.
  }

  return [...pagesById.values()]
}

async function startFacebookLogin(request, env) {
  if (!env.FACEBOOK_APP_ID || !env.FACEBOOK_APP_SECRET) {
    return redirect(appUrlWithMessage(
      request,
      'facebook_error',
      'ยังไม่ได้ตั้งค่า FACEBOOK_APP_ID และ FACEBOOK_APP_SECRET'
    ))
  }

  const state = randomId()
  await env.DB.prepare('INSERT INTO oauth_states (state, expires_at) VALUES (?, ?)')
    .bind(state, Date.now() + OAUTH_TTL_MS).run()

  const authorizeUrl = new URL(`https://www.facebook.com/${graphVersion(env)}/dialog/oauth`)
  authorizeUrl.searchParams.set('client_id', env.FACEBOOK_APP_ID)
  authorizeUrl.searchParams.set('redirect_uri', oauthRedirectUri(request, env))
  authorizeUrl.searchParams.set('state', state)
  authorizeUrl.searchParams.set('scope', 'pages_show_list,pages_read_engagement,pages_messaging,business_management')
  authorizeUrl.searchParams.set('response_type', 'code')
  return redirect(authorizeUrl.toString())
}

async function finishFacebookLogin(request, env) {
  const callbackUrl = new URL(request.url)
  const state = callbackUrl.searchParams.get('state')
  const code = callbackUrl.searchParams.get('code')
  const oauthError = callbackUrl.searchParams.get('error_message') || callbackUrl.searchParams.get('error_description')
  if (oauthError) return redirect(appUrlWithMessage(request, 'facebook_error', oauthError))

  const storedState = state
    ? await env.DB.prepare('SELECT state FROM oauth_states WHERE state = ? AND expires_at >= ?')
      .bind(state, Date.now()).first()
    : null
  if (!storedState || !code) {
    return redirect(appUrlWithMessage(request, 'facebook_error', 'Facebook Login หมดอายุหรือ state ไม่ถูกต้อง'))
  }
  await env.DB.prepare('DELETE FROM oauth_states WHERE state = ?').bind(state).run()

  try {
    const version = graphVersion(env)
    const tokenUrl = new URL(`https://graph.facebook.com/${version}/oauth/access_token`)
    tokenUrl.searchParams.set('client_id', env.FACEBOOK_APP_ID)
    tokenUrl.searchParams.set('client_secret', env.FACEBOOK_APP_SECRET)
    tokenUrl.searchParams.set('redirect_uri', oauthRedirectUri(request, env))
    tokenUrl.searchParams.set('code', code)
    const tokenResponse = await fetch(tokenUrl)
    const tokenData = await tokenResponse.json()
    if (!tokenResponse.ok || !tokenData.access_token) {
      throw new Error(tokenData?.error?.message || 'แลก Facebook access token ไม่สำเร็จ')
    }

    const exchangeUrl = new URL(`https://graph.facebook.com/${version}/oauth/access_token`)
    exchangeUrl.searchParams.set('grant_type', 'fb_exchange_token')
    exchangeUrl.searchParams.set('client_id', env.FACEBOOK_APP_ID)
    exchangeUrl.searchParams.set('client_secret', env.FACEBOOK_APP_SECRET)
    exchangeUrl.searchParams.set('fb_exchange_token', tokenData.access_token)
    const exchangeResponse = await fetch(exchangeUrl)
    const exchangeData = await exchangeResponse.json()
    const userToken = exchangeResponse.ok && exchangeData.access_token
      ? exchangeData.access_token
      : tokenData.access_token

    const pages = await fetchFacebookPages(version, userToken)
    if (pages.length === 0) {
      throw new Error('ไม่พบ Facebook Page ที่บัญชีนี้จัดการ กรุณาอนุญาต business_management และ Login ใหม่')
    }

    if (pages.length === 1) {
      await saveConnection(env, pages[0], version)
      const sessionId = await createSession(env, pages[0].id)
      return redirect(
        appUrlWithMessage(request, 'facebook_connected', '1'),
        { 'Set-Cookie': sessionCookie(request, sessionId) }
      )
    }

    const loginId = randomId()
    const pagesCipher = await encryptText(JSON.stringify(pages), env)
    await env.DB.prepare(`
      INSERT INTO pending_page_selections (id, pages_cipher, expires_at)
      VALUES (?, ?, ?)
    `).bind(loginId, pagesCipher, Date.now() + OAUTH_TTL_MS).run()
    return redirect(appUrlWithMessage(request, 'facebook_pages', loginId))
  } catch (error) {
    return redirect(appUrlWithMessage(request, 'facebook_error', error.message || 'Facebook Login ไม่สำเร็จ'))
  }
}

async function listFacebookPages(request, env) {
  const loginId = new URL(request.url).searchParams.get('login')
  const login = loginId
    ? await env.DB.prepare(`
      SELECT pages_cipher FROM pending_page_selections WHERE id = ? AND expires_at >= ?
    `).bind(loginId, Date.now()).first()
    : null
  if (!login) return json({ error: 'รายการ Page หมดอายุ กรุณา Login ใหม่' }, 404)

  const pages = JSON.parse(await decryptText(login.pages_cipher, env))
  return json({ pages: pages.map(({ id, name, category }) => ({ id, name, category: category || '' })) })
}

async function selectFacebookPage(request, env) {
  const { loginId, pageId } = await readJson(request)
  const login = await env.DB.prepare(`
    SELECT pages_cipher FROM pending_page_selections WHERE id = ? AND expires_at >= ?
  `).bind(loginId, Date.now()).first()
  if (!login) return json({ error: 'รายการ Page หมดอายุ กรุณา Login ใหม่' }, 404)

  const pages = JSON.parse(await decryptText(login.pages_cipher, env))
  const page = pages.find((item) => item.id === pageId)
  if (!page) return json({ error: 'ไม่พบ Page ที่เลือก' }, 404)

  await saveConnection(env, page, graphVersion(env))
  await env.DB.prepare('DELETE FROM pending_page_selections WHERE id = ?').bind(loginId).run()
  const sessionId = await createSession(env, page.id)
  return json(
    { ok: true, profile: { id: page.id, name: page.name, category: page.category || '' } },
    200,
    { 'Set-Cookie': sessionCookie(request, sessionId) }
  )
}

async function handleApi(request, env) {
  const url = new URL(request.url)
  const method = request.method

  if (method === 'GET' && url.pathname === '/api/health') {
    const connection = await getSessionContext(request, env)
    const pageSettings = connection ? await getPageSettings(env, connection.pageId) : null
    return json({
      ok: true,
      facebookConfigured: Boolean(connection),
      facebookProfile: connection
        ? { id: connection.pageId, name: connection.pageName, category: connection.category }
        : null,
      stockUrl: connection ? `/${encodeURIComponent(connection.pageId)}/stocks` : null,
      graphVersion: graphVersion(env, connection),
      pageSettings
    })
  }

  if (method === 'GET' && url.pathname === '/api/facebook/pages') return listFacebookPages(request, env)
  if (method === 'POST' && url.pathname === '/api/facebook/select-page') return selectFacebookPage(request, env)
  if (method === 'POST' && url.pathname === '/api/facebook/config') return configureFacebook(request, env)

  const connection = await getSessionContext(request, env)
  if (!connection) return json({ error: 'กรุณา Login with Facebook ก่อน', code: 'UNAUTHORIZED' }, 401)

  if (method === 'GET' && url.pathname === '/api/products') return listProducts(env, connection)
  if (method === 'PATCH' && url.pathname === '/api/page/settings') {
    return updatePageSettings(request, env, connection)
  }
  if (method === 'DELETE' && url.pathname === '/api/account') {
    await env.DB.batch([
      env.DB.prepare('DELETE FROM products WHERE page_id = ?').bind(connection.pageId),
      env.DB.prepare('DELETE FROM posts WHERE page_id = ?').bind(connection.pageId),
      env.DB.prepare('DELETE FROM admin_sessions WHERE page_id = ?').bind(connection.pageId),
      env.DB.prepare('DELETE FROM page_connections WHERE page_id = ?').bind(connection.pageId)
    ])
    return json(
      { ok: true, confirmationCode: randomId(8) },
      200,
      { 'Set-Cookie': clearSessionCookie(request) }
    )
  }
  if (method === 'DELETE' && url.pathname === '/api/data') {
    await env.DB.batch([
      env.DB.prepare('DELETE FROM products WHERE page_id = ?').bind(connection.pageId),
      env.DB.prepare('DELETE FROM posts WHERE page_id = ?').bind(connection.pageId)
    ])
    return json({ ok: true })
  }

  const productMatch = url.pathname.match(/^\/api\/products\/(.+)$/)
  if (method === 'PATCH' && productMatch) {
    return updateProduct(request, env, connection, decodeURIComponent(productMatch[1]))
  }

  const postMatch = url.pathname.match(/^\/api\/posts\/(.+)$/)
  if (method === 'DELETE' && postMatch) {
    const postId = decodeURIComponent(postMatch[1])
    const result = await env.DB.prepare('DELETE FROM posts WHERE id = ? AND page_id = ?')
      .bind(postId, connection.pageId).run()
    if (!result.meta.changes) return json({ error: 'ไม่พบโพสต์' }, 404)
    return json({ ok: true })
  }

  if (method === 'POST' && url.pathname === '/api/facebook/import') {
    return fetchAndStoreFacebookPost(request, env, connection)
  }
  if (method === 'GET' && url.pathname === '/api/facebook/posts') {
    return listFacebookPosts(request, env, connection)
  }
  if (method === 'POST' && url.pathname === '/api/facebook/sync') {
    return syncFacebookPhotos(request, env, connection)
  }

  return json({ error: 'Not found' }, 404)
}

export default {
  async fetch(request, env, context) {
    try {
      await cleanupExpired(env.DB)
      const url = new URL(request.url)

      if (url.pathname === '/webhooks/messenger') {
        return handleMessengerWebhook(request, env, context)
      }

      if (request.method === 'GET' && url.pathname === '/auth/facebook') {
        return startFacebookLogin(request, env)
      }
      if (request.method === 'GET' && url.pathname === '/auth/facebook/callback') {
        return finishFacebookLogin(request, env)
      }
      if (url.pathname.startsWith('/api/')) return handleApi(request, env)
      const stockImageMatch = url.pathname.match(/^\/([^/]+)\/stocks\/image\/([^/]+)\/?$/)
      if (request.method === 'GET' && stockImageMatch) {
        return downloadPublicStockImage(
          env,
          decodeURIComponent(stockImageMatch[1]),
          decodeURIComponent(stockImageMatch[2])
        )
      }
      const stockMatch = url.pathname.match(/^\/([^/]+)\/stocks(?:\/([^/]+))?\/?$/)
      if (request.method === 'GET' && stockMatch) {
        const postId = stockMatch[2]
          ? decodeURIComponent(stockMatch[2])
          : url.searchParams.get('pid') || ''
        return renderPublicStocks(
          env,
          decodeURIComponent(stockMatch[1]),
          postId,
          url.searchParams.get('section') || ''
        )
      }
      return env.ASSETS.fetch(request)
    } catch (error) {
      console.error(error)
      return json({ error: error.message || 'เกิดข้อผิดพลาดที่ server' }, 500)
    }
  }
}
