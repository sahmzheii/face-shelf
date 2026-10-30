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
      const fallbackCaption = product.attachmentCaption || product.caption || ''
      if (!product.facebookPhotoId) {
        return {
          ...product,
          caption: fallbackCaption,
          originalCaption: fallbackCaption,
          sold: fallbackCaption ? captionIsSoldOut(fallbackCaption) : Boolean(product.sold),
          captionResolved: Boolean(fallbackCaption)
        }
      }

      const photoData = photoDataById[String(product.facebookPhotoId)]
      if (photoData?.id && !photoData.error) {
        const caption = photoData.name || fallbackCaption
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
        sold: fallbackCaption ? captionIsSoldOut(fallbackCaption) : Boolean(product.sold),
        captionResolved: Boolean(fallbackCaption)
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
    SELECT facebook_photo_id, is_artwork
    FROM products
    WHERE page_id = ? AND post_id = ?
  `).bind(connection.pageId, post.id).all()
  const artworkByPhotoId = new Map(
    (existing.results || []).map((item) => [item.facebook_photo_id, Boolean(item.is_artwork)])
  )
  const now = Date.now()
  const stored = products.map((product, index) => ({
    ...product,
    id: `${post.id}-${String(index + 1).padStart(2, '0')}`,
    postId: post.id,
    postCreatedTime: post.createdTime || '',
    isArtwork: artworkByPhotoId.get(product.facebookPhotoId) || false
  }))

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

async function fetchAttachmentCaptions(postIds, version, token) {
  const captions = new Map()
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
        for (const image of extractImages(postData.attachments?.data)) {
          if (image.facebookPhotoId && image.attachmentCaption) {
            captions.set(String(image.facebookPhotoId), image.attachmentCaption)
          }
        }
      }
    } catch {}
  }

  return captions
}

async function syncFacebookPhotos(request, env, connection) {
  const { photoIds } = await readJson(request)
  const uniquePhotoIds = [...new Set(
    (Array.isArray(photoIds) ? photoIds : []).filter((photoId) => /^\d+$/.test(String(photoId)))
  )]
  if (uniquePhotoIds.length === 0) return json({ items: [] })
  if (uniquePhotoIds.length > 500) return json({ error: 'Sync ได้สูงสุด 500 รูปต่อครั้ง' }, 400)

  const placeholders = uniquePhotoIds.map(() => '?').join(', ')
  const storedProducts = await env.DB.prepare(`
    SELECT facebook_photo_id, post_id, caption, original_caption, sold
    FROM products
    WHERE page_id = ? AND facebook_photo_id IN (${placeholders})
  `).bind(connection.pageId, ...uniquePhotoIds).all()
  const products = (storedProducts.results || []).map((product) => ({
    facebookPhotoId: String(product.facebook_photo_id),
    postId: product.post_id,
    caption: product.caption || '',
    originalCaption: product.original_caption || '',
    sold: Boolean(product.sold)
  }))
  const attachmentCaptions = await fetchAttachmentCaptions(
    products.map((product) => product.postId),
    graphVersion(env, connection),
    connection.accessToken
  )
  for (const product of products) {
    product.attachmentCaption = attachmentCaptions.get(product.facebookPhotoId) || ''
  }

  const synced = await addPhotoCaptions(products, graphVersion(env, connection), connection.accessToken)
  const now = Date.now()
  const resolved = synced.filter((item) => item.captionResolved)
  await runBatches(env.DB, resolved.map((item) => env.DB.prepare(`
    UPDATE products
    SET caption = ?, original_caption = ?, sold = ?, updated_at = ?
    WHERE page_id = ? AND facebook_photo_id = ?
  `).bind(
    item.caption || '',
    item.originalCaption || item.caption || '',
    item.sold ? 1 : 0,
    now,
    connection.pageId,
    item.facebookPhotoId
  )))
  return json({
    items: synced.map(({ facebookPhotoId, caption, sold, captionResolved }) => ({
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
  authorizeUrl.searchParams.set('scope', 'pages_show_list,pages_read_engagement')
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

    const pagesUrl = new URL(`https://graph.facebook.com/${version}/me/accounts`)
    pagesUrl.searchParams.set('fields', 'id,name,category,access_token,tasks')
    pagesUrl.searchParams.set('access_token', userToken)
    const pagesResponse = await fetch(pagesUrl)
    const pagesData = await pagesResponse.json()
    if (!pagesResponse.ok) throw new Error(pagesData?.error?.message || 'ดึงรายการ Page ไม่สำเร็จ')

    const pages = (pagesData.data || []).filter((page) => page.access_token)
    if (pages.length === 0) throw new Error('ไม่พบ Facebook Page ที่บัญชีนี้จัดการ')

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
    return json({
      ok: true,
      facebookConfigured: Boolean(connection),
      facebookProfile: connection
        ? { id: connection.pageId, name: connection.pageName, category: connection.category }
        : null,
      graphVersion: graphVersion(env, connection)
    })
  }

  if (method === 'GET' && url.pathname === '/api/facebook/pages') return listFacebookPages(request, env)
  if (method === 'POST' && url.pathname === '/api/facebook/select-page') return selectFacebookPage(request, env)
  if (method === 'POST' && url.pathname === '/api/facebook/config') return configureFacebook(request, env)

  const connection = await getSessionContext(request, env)
  if (!connection) return json({ error: 'กรุณา Login with Facebook ก่อน', code: 'UNAUTHORIZED' }, 401)

  if (method === 'GET' && url.pathname === '/api/products') return listProducts(env, connection)
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
  async fetch(request, env) {
    try {
      await cleanupExpired(env.DB)
      const url = new URL(request.url)

      if (request.method === 'GET' && url.pathname === '/auth/facebook') {
        return startFacebookLogin(request, env)
      }
      if (request.method === 'GET' && url.pathname === '/auth/facebook/callback') {
        return finishFacebookLogin(request, env)
      }
      if (url.pathname.startsWith('/api/')) return handleApi(request, env)
      return env.ASSETS.fetch(request)
    } catch (error) {
      console.error(error)
      return json({ error: error.message || 'เกิดข้อผิดพลาดที่ server' }, 500)
    }
  }
}
