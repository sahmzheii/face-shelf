import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { webcrypto } from 'node:crypto'
import { test } from 'node:test'
import { Miniflare, convertV4MiniflareOptions } from 'miniflare'
import worker, { saveImportedPost, cleanupEventImages } from '../src/index.js'

test('event lifecycle, ownership, public page and sync persistence', async (t) => {
  const mf = new Miniflare(convertV4MiniflareOptions({ workers: [{ name: 'events-test', modules: true, script: 'export default { fetch() { return new Response("ok") } }', d1Databases: ['DB'], r2Buckets: ['EVENT_IMAGES'] }] }))
  try {
    const DB = await mf.getD1Database('DB')
    const schema = await readFile(new URL('../schema.sql', import.meta.url), 'utf8')
    await DB.batch(schema.split(';').map((sql) => sql.trim()).filter(Boolean).map((sql) => DB.prepare(sql)))
    // Existing installations can apply the migration repeatedly without losing data.
    const migration = await readFile(new URL('../migrations/0001_events.sql', import.meta.url), 'utf8')
    await DB.batch(migration.split(';').map((sql) => sql.trim()).filter(Boolean).map((sql) => DB.prepare(sql)))
    const env = { DB, EVENT_IMAGES: await mf.getR2Bucket('EVENT_IMAGES'), TOKEN_ENCRYPTION_KEY: 'events-test-key' }
    const now = Date.now()
    const key = await webcrypto.subtle.importKey('raw', await webcrypto.subtle.digest('SHA-256', new TextEncoder().encode(env.TOKEN_ENCRYPTION_KEY)), 'AES-GCM', false, ['encrypt'])
    const iv = webcrypto.getRandomValues(new Uint8Array(12))
    const encrypted = new Uint8Array(await webcrypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode('test-token')))
    const cipher = Buffer.concat([iv, encrypted]).toString('base64')
    for (const page of ['shop-a', 'shop-b']) {
      await DB.prepare('INSERT INTO page_connections (page_id, page_name, access_token_cipher, updated_at) VALUES (?, ?, ?, ?)').bind(page, page, cipher, now).run()
      await DB.prepare('INSERT INTO admin_sessions (id, page_id, expires_at, created_at) VALUES (?, ?, ?, ?)').bind(page, page, now + 60000, now).run()
    }
    const api = async (path, method = 'GET', body, page = 'shop-a') => worker.fetch(new Request(`http://localhost${path}`, {
      method, headers: { Cookie: `face_shelf_session=${page}`, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    }), env, {})
    const photo = (id) => ({ facebookPhotoId: id, imageUrl: `https://example.com/${id}.jpg`, sold: id === 'sold' })
    await saveImportedPost(env, { pageId: 'shop-a' }, { id: 'post-a' }, [photo('available'), photo('sold'), photo('outside')])
    await saveImportedPost(env, { pageId: 'shop-b' }, { id: 'post-b' }, [photo('foreign')])
    let event
    await t.test('auth and input validation', async () => {
      assert.equal((await api('/api/events', 'GET', undefined, '')).status, 401)
      for (const body of [{ name: '  ' }, { name: 'x'.repeat(101) }, { name: 'Valid', description: 'x'.repeat(2001) }]) {
        assert.equal((await api('/api/events', 'POST', body)).status, 400)
      }
    })
    await t.test('create and edit event; isolate shops', async () => {
      const response = await api('/api/events', 'POST', { name: 'Sale <script>', description: 'Details [link](https://example.com)' })
      assert.equal(response.status, 201)
      event = (await response.json()).event
      assert.equal(event.stockUrl, `/stocks/event/${event.id}`)
      assert.equal((await (await api('/api/events', 'GET', undefined, 'shop-b')).json()).events.length, 0)
      assert.equal((await api(`/api/events/${event.id}`, 'PATCH', { name: 'Hacked' }, 'shop-b')).status, 404)
      assert.equal((await api(`/api/events/${event.id}`, 'PATCH', { name: 'Sale <script>', description: '<script>alert(1)</script>' })).status, 200)
    })
    await t.test('add products idempotently; reject foreign products', async () => {
      for (const id of ['post-a-01', 'post-a-01', 'post-a-02']) {
        assert.equal((await api(`/api/events/${event.id}/products/${id}`, 'PUT')).status, 200)
      }
      assert.equal((await api(`/api/events/${event.id}/products/post-b-01`, 'PUT')).status, 404)
      assert.equal((await api(`/api/events/${event.id}/products/post-a-01`, 'DELETE', undefined, 'shop-b')).status, 404)
      const products = (await (await api('/api/products')).json()).products
      assert.deepEqual(products.find((p) => p.id === 'post-a-01').eventIds, [event.id])
      assert.deepEqual(products.find((p) => p.id === 'post-a-03').eventIds, [])
    })
    await t.test('public page includes event products and sold status; escapes content', async () => {
      const response = await api(event.stockUrl)
      assert.equal(response.status, 200)
      const html = await response.text()
      assert.ok(html.includes('Sale &lt;script&gt;'))
      assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'))
      assert.ok(html.includes('post-a-01'))
      assert.ok(html.includes('post-a-02'))
      assert.ok(html.includes('ขายแล้ว'))
      assert.ok(!html.includes('post-a-03'))
      assert.ok(!html.includes('post-b-01'))
      const shop = await (await api('/shop-a/stocks')).text()
      assert.ok(!shop.includes('post-a-02'))
      assert.equal((await api('/stocks/event/missing')).status, 404)
    })
    await t.test('event tag colors, markdown images and preview use the same safe HTML', async () => {
      for (const body of [{ tag: 'x'.repeat(101) }, { tagColor: 'red' }, { tagBackgroundColor: '#fff; color:red' }, { tagColor: ['#ffffff'] }]) {
        assert.equal((await api(`/api/events/${event.id}`, 'PATCH', { name: event.name, ...body })).status, 400)
      }
      const description = '# Event details\n\n**Special collection**\n\n![Banner](https://example.com/banner.jpg "Banner title")\n\n- First item\n- Second item\n\n[Shop](https://example.com/shop)\n\n<script>alert(1)</script>\n\n[Unsafe](javascript:alert%281%29)\n\n![Unsafe image](data:text/html,bad)'
      const response = await api(`/api/events/${event.id}`, 'PATCH', {
        name: event.name, tag: 'SALE', tagColor: '#112233', tagBackgroundColor: '#aabbcc', description
      })
      assert.equal(response.status, 200)
      const updated = (await response.json()).event
      assert.equal(updated.tag, 'SALE')
      assert.equal(updated.tagColor, '#112233')
      assert.equal(updated.tagBackgroundColor, '#aabbcc')
      const preview = await (await api('/api/events/preview', 'POST', { description })).json()
      assert.equal(preview.html, updated.descriptionHtml)
      assert.ok(preview.html.includes('<h1>Event details</h1>'))
      assert.ok(preview.html.includes('<strong>Special collection</strong>'))
      assert.ok(preview.html.includes('<img src="https://example.com/banner.jpg"'))
      assert.ok(preview.html.includes('<ul>'))
      assert.ok(!preview.html.includes('<script>'))
      assert.ok(!preview.html.includes('href="javascript:'))
      assert.ok(!preview.html.includes('src="data:'))
      assert.equal((await api('/api/events/preview', 'POST', { description }, '')).status, 401)
      assert.equal((await api('/api/events/preview', 'POST', { description: 'x'.repeat(2001) })).status, 400)
      const html = await (await api(`${event.stockUrl}?section=post`)).text()
      assert.ok(html.includes(preview.html))
      assert.ok(html.includes('color: #112233; background-color: #aabbcc'))
      assert.ok(html.includes('>SALE</span>'))
      assert.ok(!html.includes('<header>'))
      assert.ok(!html.includes('<select class="section-filter"'))
      assert.ok(!html.includes('class="post-section'))
      assert.ok(html.includes('class="event-public"'))
      const shop = await (await api('/shop-a/stocks')).text()
      assert.ok(shop.includes('<header>'))
      assert.ok(shop.includes('<select class="section-filter"'))
      assert.ok(!shop.includes('event-markdown.css'))
      // Editing existing event details without badge fields keeps its customization.
      const edited = await (await api(`/api/events/${event.id}`, 'PATCH', { name: 'Updated', description })).json()
      assert.equal(edited.event.tag, 'SALE')
      assert.equal(edited.event.tagColor, '#112233')
    })
    await t.test('local image upload, shared references and 24-hour garbage collection', async () => {
      const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j7mQAAAAASUVORK5CYII=', 'base64')
      const upload = (bytes = png, type = 'image/png', page = 'shop-a') => worker.fetch(new Request('http://localhost/api/events/images', {
        method: 'POST', headers: { Cookie: `face_shelf_session=${page}`, 'Content-Type': type }, body: bytes
      }), env, {})
      const publicGet = (url) => worker.fetch(new Request(`http://localhost${url}`), env, {})
      assert.equal((await upload(png, 'image/png', '')).status, 401)
      assert.equal((await upload('<svg></svg>', 'image/svg+xml')).status, 415)
      assert.equal((await upload('not an image')).status, 415)
      assert.equal((await upload(new Uint8Array(200_001))).status, 413)
      const exactLimit = new Uint8Array(200_000)
      exactLimit.set(png)
      assert.equal((await upload(exactLimit)).status, 201)
      const declaredOversize = await worker.fetch(new Request('http://localhost/api/events/images', {
        method: 'POST', headers: { Cookie: 'face_shelf_session=shop-a', 'Content-Type': 'image/png', 'Content-Length': '200001' }, body: png
      }), env, {})
      assert.equal(declaredOversize.status, 413)
      const result = await upload()
      assert.equal(result.status, 201)
      const image = (await result.json()).image
      const draft = (await (await upload()).json()).image
      const row = await DB.prepare('SELECT * FROM event_images WHERE id = ?').bind(image.id).first()
      assert.ok(row.delete_after > Date.now())
      assert.equal((await publicGet(image.url)).status, 404)
      assert.equal((await api(image.url, 'GET', undefined, 'shop-b')).status, 404)
      const ownPreview = await api(image.url)
      assert.equal(ownPreview.status, 200)
      assert.equal(ownPreview.headers.get('Cache-Control'), 'private, no-store')
      assert.deepEqual(Buffer.from(await ownPreview.arrayBuffer()), png)
      const create = (name, description, page = 'shop-a') => api('/api/events', 'POST', { name, description }, page)
      assert.equal((await create('Foreign image', `![image](${image.url})`, 'shop-b')).status, 400)
      const first = (await (await create('Image event', `![image](${image.url})`)).json()).event
      const second = (await (await create('Shared image', `![image](http://localhost${image.url})`)).json()).event
      assert.equal((await publicGet(image.url)).status, 200)
      assert.equal((await DB.prepare('SELECT delete_after FROM event_images WHERE id = ?').bind(image.id).first()).delete_after, null)
      // A referenced image cannot be claimed for deletion, even in a concurrent cleanup.
      await assert.rejects(DB.prepare("UPDATE event_images SET status = 'deleting' WHERE id = ?").bind(image.id).run())
      await api(`/api/events/${first.id}`, 'PATCH', { name: first.name, description: '' })
      assert.equal((await DB.prepare('SELECT delete_after FROM event_images WHERE id = ?').bind(image.id).first()).delete_after, null)
      await api(`/api/events/${second.id}`, 'DELETE')
      const orphan = await DB.prepare('SELECT * FROM event_images WHERE id = ?').bind(image.id).first()
      assert.ok(orphan.delete_after >= Date.now() + 24 * 60 * 60 * 1000 - 5000)
      await cleanupEventImages(env, orphan.delete_after - 1)
      assert.ok(await env.EVENT_IMAGES.get(row.object_key))
      // Re-using a removed image within the grace period cancels its deletion.
      await api(`/api/events/${first.id}`, 'PATCH', { name: first.name, description: `![image](${image.url})` })
      await cleanupEventImages(env, orphan.delete_after + 1)
      assert.equal((await publicGet(image.url)).status, 200)
      assert.equal(await DB.prepare('SELECT id FROM event_images WHERE id = ?').bind(draft.id).first(), null)
      await api(`/api/events/${first.id}`, 'DELETE')
      const deadline = (await DB.prepare('SELECT delete_after FROM event_images WHERE id = ?').bind(image.id).first()).delete_after
      await cleanupEventImages(env, deadline + 1)
      assert.equal(await env.EVENT_IMAGES.get(row.object_key), null)
      assert.equal(await DB.prepare('SELECT id FROM event_images WHERE id = ?').bind(image.id).first(), null)
      assert.equal((await publicGet(image.url)).status, 404)
      assert.equal((await create('Expired image', `![image](${image.url})`)).status, 400)
    })
    await t.test('unfinished deletions are retried and cannot be referenced again', async () => {
      const id = 'a'.repeat(48)
      const key = `events/shop-a/${id}`
      await env.EVENT_IMAGES.put(key, 'old image')
      await DB.prepare("INSERT INTO event_images (id, page_id, object_key, content_type, size, status, delete_after, created_at) VALUES (?, ?, ?, ?, ?, 'deleting', ?, ?)")
        .bind(id, 'shop-a', key, 'image/png', 9, Date.now() - 1, Date.now()).run()
      const response = await api('/api/events', 'POST', { name: 'Cannot resurrect', description: `![image](/media/events/${id})` })
      assert.equal(response.status, 400)
      await cleanupEventImages(env)
      assert.equal(await env.EVENT_IMAGES.get(key), null)
      assert.equal(await DB.prepare('SELECT id FROM event_images WHERE id = ?').bind(id).first(), null)
    })
    await t.test('account deletion retains image records until their storage is collected', async () => {
      const id = 'b'.repeat(48)
      const key = `events/shop-b/${id}`
      await env.EVENT_IMAGES.put(key, 'test')
      await DB.prepare('INSERT INTO event_images (id, page_id, object_key, content_type, size, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .bind(id, 'shop-b', key, 'image/png', 4, Date.now()).run()
      const imageEvent = (await (await api('/api/events', 'POST', { name: 'Account image', description: `![image](/media/events/${id})` }, 'shop-b')).json()).event
      assert.ok(imageEvent.id)
      assert.equal((await api('/api/account', 'DELETE', undefined, 'shop-b')).status, 200)
      const retained = await DB.prepare('SELECT delete_after FROM event_images WHERE id = ?').bind(id).first()
      assert.ok(retained.delete_after > Date.now())
      await cleanupEventImages(env, retained.delete_after + 1)
      assert.equal(await env.EVENT_IMAGES.get(key), null)
      assert.equal(await DB.prepare('SELECT id FROM event_images WHERE id = ?').bind(id).first(), null)
    })
    await t.test('sync reordered photos preserves membership by photo identity', async () => {
      const imported = await saveImportedPost(env, { pageId: 'shop-a' }, { id: 'post-a' }, [photo('outside'), photo('sold'), photo('available')])
      assert.deepEqual(imported[0].eventIds, [])
      assert.deepEqual(imported[1].eventIds, [event.id])
      assert.deepEqual(imported[2].eventIds, [event.id])
      const products = (await (await api('/api/products')).json()).products
      assert.deepEqual(products.find((p) => p.facebookPhotoId === 'available').eventIds, [event.id])
      assert.deepEqual(products.find((p) => p.facebookPhotoId === 'outside').eventIds, [])
    })
    await t.test('remove membership; delete event keeps products', async () => {
      assert.equal((await api(`/api/events/${event.id}/products/post-a-02`, 'DELETE')).status, 200)
      assert.ok(!(await (await api(event.stockUrl)).text()).includes('post-a-02'))
      assert.equal((await api(`/api/events/${event.id}`, 'DELETE')).status, 200)
      assert.equal((await api(event.stockUrl)).status, 404)
      const products = (await (await api('/api/products')).json()).products
      assert.equal(products.length, 3)
      assert.ok(products.every((p) => p.eventIds.length === 0))
      assert.equal((await DB.prepare('SELECT COUNT(*) AS n FROM event_products').first()).n, 0)
    })
  } finally {
    await mf.dispose()
  }
})

test('event detail migration preserves existing events', async () => {
  const mf = new Miniflare(convertV4MiniflareOptions({ workers: [{ name: 'migration-test', modules: true, script: 'export default { fetch() { return new Response("ok") } }', d1Databases: ['DB'] }] }))
  try {
    const DB = await mf.getD1Database('DB')
    const schema = (await readFile(new URL('../schema.sql', import.meta.url), 'utf8'))
      .replace("  tag TEXT NOT NULL DEFAULT '',\n", '')
      .replace("  tag_color TEXT NOT NULL DEFAULT '#ffffff',\n", '')
      .replace("  tag_background_color TEXT NOT NULL DEFAULT '#256f4a',\n", '')
    await DB.batch(schema.split(';').map((sql) => sql.trim()).filter(Boolean).map((sql) => DB.prepare(sql)))
    await DB.prepare("INSERT INTO page_connections (page_id, page_name, access_token_cipher, updated_at) VALUES ('legacy', 'Legacy', '', 1)").run()
    await DB.prepare("INSERT INTO events (id, page_id, name, description, created_at, updated_at) VALUES ('legacy-event', 'legacy', 'Legacy Sale', 'Description', 1, 1)").run()
    const migration = await readFile(new URL('../migrations/0002_event_details.sql', import.meta.url), 'utf8')
    await DB.batch(migration.split(';').map((sql) => sql.trim()).filter(Boolean).map((sql) => DB.prepare(sql)))
    const event = await DB.prepare("SELECT * FROM events WHERE id = 'legacy-event'").first()
    assert.equal(event.tag, 'Legacy Sale')
    assert.equal(event.tag_color, '#ffffff')
    assert.equal(event.tag_background_color, '#256f4a')
    assert.equal(event.description, 'Description')
  } finally { await mf.dispose() }
})
