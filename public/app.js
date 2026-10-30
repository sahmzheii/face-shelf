const state = {
  products: [],
  filter: 'all',
  search: '',
  postId: null,
  postSort: 'date'
}

const grid = document.querySelector('#productGrid')
const emptyState = document.querySelector('#emptyState')
const template = document.querySelector('#productTemplate')
const dialog = document.querySelector('#importDialog')
const form = document.querySelector('#importForm')
const importError = document.querySelector('#importError')
const settingsDialog = document.querySelector('#settingsDialog')
const settingsForm = document.querySelector('#settingsForm')
const settingsError = document.querySelector('#settingsError')
const connectionErrorDialog = document.querySelector('#connectionErrorDialog')
const connectionErrorMessage = document.querySelector('#connectionErrorMessage')
const errorDialogTitle = document.querySelector('#errorDialogTitle')
const soldConfirmDialog = document.querySelector('#soldConfirmDialog')
const pagePickerDialog = document.querySelector('#pagePickerDialog')
const pagePickerList = document.querySelector('#pagePickerList')
const postList = document.querySelector('#postList')
const postItemTemplate = document.querySelector('#postItemTemplate')
const linkImportPanel = document.querySelector('#linkImportPanel')
const browseImportPanel = document.querySelector('#browseImportPanel')
const facebookPostList = document.querySelector('#facebookPostList')
const emptyFacebookPosts = document.querySelector('#emptyFacebookPosts')
const selectedPostCount = document.querySelector('#selectedPostCount')
const importSelectedPosts = document.querySelector('#importSelectedPosts')
const previousFacebookPosts = document.querySelector('#previousFacebookPosts')
const nextFacebookPosts = document.querySelector('#nextFacebookPosts')
const facebookPostPage = document.querySelector('#facebookPostPage')
let pendingSoldProduct = null
const facebookPostBrowser = {
  cursors: [''],
  pageIndex: 0,
  nextCursor: null,
  hasNext: false,
  posts: [],
  selected: new Set(),
  loaded: false
}

function showErrorDialog(title, message) {
  errorDialogTitle.textContent = title
  connectionErrorMessage.textContent = message
  connectionErrorDialog.showModal()
}

async function requestJson(url, options) {
  const response = await fetch(url, options)
  const body = await response.text()
  let data

  try {
    data = body ? JSON.parse(body) : {}
  } catch {
    throw new Error(`Server ตอบกลับผิดรูปแบบ (${response.status}) กรุณาลองใหม่`)
  }

  if (!response.ok) throw new Error(data.error || 'เกิดข้อผิดพลาดจาก server')
  return data
}

async function loadProducts() {
  const data = await requestJson('/api/products')
  state.products = data.products || []
  render()
}

async function persistProduct(product) {
  await requestJson(`/api/products/${encodeURIComponent(product.id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sold: product.sold, isArtwork: product.isArtwork })
  })
}

async function refreshProducts() {
  try {
    await loadProducts()
  } catch (error) {
    showErrorDialog('โหลดข้อมูลสินค้าไม่สำเร็จ', error.message)
  }
}

function visibleProducts() {
  return state.products.filter((product) => {
    const matchesStatus = state.filter === 'artwork'
      ? product.isArtwork
      : !product.isArtwork && (state.filter === 'all' || (state.filter === 'sold' ? product.sold : !product.sold))
    const matchesSearch = product.id.toLowerCase().includes(state.search.toLowerCase())
    const matchesPost = !state.postId || product.postId === state.postId
    return matchesStatus && matchesSearch && matchesPost
  })
}

function getPostGroups() {
  const groups = new Map()

  for (const product of state.products) {
    if (!product.postId) continue
    if (!groups.has(product.postId)) {
      groups.set(product.postId, {
        postId: product.postId,
        products: [],
        artwork: null,
        createdTime: product.postCreatedTime || ''
      })
    }

    const group = groups.get(product.postId)
    group.createdTime ||= product.postCreatedTime || ''
    if (product.isArtwork) group.artwork ||= product
    else group.products.push(product)
  }

  return [...groups.values()]
}

function formatPostDate(value) {
  if (!value) return 'ไม่พบวันที่'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return 'ไม่พบวันที่'

  const formatted = new Intl.DateTimeFormat('en-GB', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    timeZone: 'Asia/Bangkok'
  }).format(date)
  const days = Math.max(0, Math.floor((Date.now() - date.getTime()) / 86400000))
  const relative = days === 0 ? 'วันนี้' : `${days} วันที่แล้ว`
  return `${formatted} (${relative})`
}

function replaceImportedPost(data) {
  const existingByPhotoId = new Map(
    state.products.map((product) => [product.facebookPhotoId, product])
  )
  const imported = data.products.map((product, index) => {
    const existing = existingByPhotoId.get(product.facebookPhotoId)
    return {
      ...product,
      id: `${data.post.id}-${String(index + 1).padStart(2, '0')}`,
      postId: data.post.id,
      postCreatedTime: data.post.createdTime || existing?.postCreatedTime || '',
      isArtwork: existing?.isArtwork || false
    }
  })

  state.products = [
    ...imported,
    ...state.products.filter((product) => product.postId !== data.post.id)
  ]
}

async function updatePost(group, button) {
  button.disabled = true
  button.textContent = 'กำลัง Update…'

  try {
    const data = await requestJson('/api/facebook/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ postId: group.postId })
    })

    replaceImportedPost(data)
    render()
  } catch (error) {
    button.disabled = false
    button.textContent = 'Update'
    showErrorDialog('Update โพสต์ไม่สำเร็จ', error.message || 'กรุณาตรวจการเชื่อมต่อ Facebook')
  }
}

function renderPostList() {
  const groups = getPostGroups().sort((left, right) => {
    if (state.postSort === 'available') {
      const leftAvailable = left.products.filter((product) => !product.sold).length
      const rightAvailable = right.products.filter((product) => !product.sold).length
      return rightAvailable - leftAvailable
    }
    return new Date(right.createdTime || 0).getTime() - new Date(left.createdTime || 0).getTime()
  })
  postList.replaceChildren()
  document.querySelector('#postCount').textContent = groups.length
  document.querySelector('#emptyPostList').hidden = groups.length > 0
  document.querySelector('#showAllPosts').classList.toggle('active', !state.postId)

  for (const group of groups) {
    const item = postItemTemplate.content.firstElementChild.cloneNode(true)
    const sold = group.products.filter((product) => product.sold).length
    const available = group.products.length - sold
    const image = item.querySelector('img')

    item.classList.toggle('active', state.postId === group.postId)
    item.querySelector('.post-id').textContent = group.postId
    item.querySelector('.post-total').textContent = `${group.products.length} สินค้า`
    item.querySelector('.post-sold').textContent = `${sold} sold-out`
    item.querySelector('.post-available').textContent = `${available} available`
    item.querySelector('.post-date').textContent = formatPostDate(group.createdTime)

    if (group.artwork?.imageUrl) {
      image.src = group.artwork.imageUrl
      image.alt = `Artwork ของโพสต์ ${group.postId}`
      item.querySelector('.post-thumb').classList.add('has-image')
    }

    item.querySelector('.post-item-main').addEventListener('click', () => {
      state.postId = state.postId === group.postId ? null : group.postId
      render()
    })
    item.querySelector('.post-update').addEventListener('click', (event) => {
      event.preventDefault()
      updatePost(group, event.currentTarget)
    })
    item.querySelector('.post-remove').addEventListener('click', async (event) => {
      event.preventDefault()
      if (!window.confirm(`ลบโพสต์ ${group.postId} และสินค้าทั้งหมดออกจากระบบ?`)) return
      try {
        await requestJson(`/api/posts/${encodeURIComponent(group.postId)}`, { method: 'DELETE' })
        state.products = state.products.filter((product) => product.postId !== group.postId)
        if (state.postId === group.postId) state.postId = null
        render()
      } catch (error) {
        showErrorDialog('ลบโพสต์ไม่สำเร็จ', error.message)
      }
    })
    postList.append(item)
  }
}

function updateSummary() {
  const products = state.products.filter((product) => (
    !product.isArtwork && (!state.postId || product.postId === state.postId)
  ))
  const sold = products.filter((product) => product.sold).length
  document.querySelector('#totalCount').textContent = products.length
  document.querySelector('#availableCount').textContent = products.length - sold
  document.querySelector('#soldCount').textContent = sold
}

function render() {
  const products = visibleProducts()
  grid.replaceChildren()

  for (const product of products) {
    const card = template.content.firstElementChild.cloneNode(true)
    card.classList.toggle('sold', product.sold)
    card.classList.toggle('artwork', product.isArtwork)
    const image = card.querySelector('img')
    image.src = product.imageUrl
    image.alt = `สินค้า ${product.id}`
    card.querySelector('.product-code').textContent = product.id

    const openFacebookPhoto = () => {
      if (!product.targetUrl) {
        showErrorDialog('เปิด Facebook ไม่สำเร็จ', 'ไม่พบลิงก์ Facebook ของรูปนี้ กรุณานำเข้าโพสต์ใหม่')
        return
      }

      window.open(
        product.targetUrl,
        `facebook-photo-${product.facebookPhotoId || product.id}`,
        'popup=yes,width=1100,height=820,resizable=yes,scrollbars=yes'
      )
    }

    const imageWrap = card.querySelector('.image-wrap')
    imageWrap.setAttribute('role', 'link')
    imageWrap.setAttribute('tabindex', '0')
    imageWrap.setAttribute('aria-label', `เปิดสินค้า ${product.id} บน Facebook`)
    imageWrap.addEventListener('click', openFacebookPhoto)
    imageWrap.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') openFacebookPhoto()
    })

    const artworkLink = card.querySelector('.artwork-link')
    artworkLink.addEventListener('click', (event) => {
      event.stopPropagation()
      openFacebookPhoto()
    })

    const toggle = card.querySelector('.sold-toggle')
    toggle.textContent = product.sold ? 'ยกเลิกขายหมด' : 'Mark sold out'
    toggle.setAttribute('aria-label', `${toggle.textContent} ${product.id}`)
    toggle.addEventListener('click', async () => {
      if (product.sold) {
        const previous = product.sold
        product.sold = false
        render()
        try {
          await persistProduct(product)
        } catch (error) {
          product.sold = previous
          render()
          showErrorDialog('อัปเดตสถานะไม่สำเร็จ', error.message)
        }
        return
      }

      openFacebookPhoto()
      pendingSoldProduct = product
      soldConfirmDialog.showModal()
    })

    const artworkToggle = card.querySelector('.artwork-toggle')
    const cardMenu = card.querySelector('.card-menu')
    cardMenu.addEventListener('click', (event) => event.stopPropagation())
    cardMenu.addEventListener('keydown', (event) => event.stopPropagation())
    artworkToggle.textContent = product.isArtwork ? 'นำกลับเป็นสินค้า' : 'make art-work'
    artworkToggle.addEventListener('click', async (event) => {
      event.preventDefault()
      const previous = product.isArtwork
      product.isArtwork = !product.isArtwork
      cardMenu.open = false
      render()
      try {
        await persistProduct(product)
      } catch (error) {
        product.isArtwork = previous
        render()
        showErrorDialog('อัปเดต Art-work ไม่สำเร็จ', error.message)
      }
    })

    toggle.hidden = Boolean(product.isArtwork)

    grid.append(card)
  }

  emptyState.hidden = products.length > 0
  updateSummary()
  renderPostList()
  document.querySelector('#syncSelectedPost').hidden = !state.postId
}

function updateSelectedPostCount(message = '') {
  const count = facebookPostBrowser.selected.size
  selectedPostCount.textContent = message || `เลือกแล้ว ${count} โพสต์`
  importSelectedPosts.disabled = count === 0
}

function renderFacebookPosts() {
  facebookPostList.replaceChildren()

  for (const post of facebookPostBrowser.posts) {
    const option = document.createElement('label')
    const checkbox = document.createElement('input')
    const content = document.createElement('span')
    const images = document.createElement('span')
    const caption = document.createElement('span')
    const meta = document.createElement('span')
    const postId = document.createElement('span')
    const date = document.createElement('span')
    const importedBadge = document.createElement('span')

    option.className = 'facebook-post-option'
    checkbox.type = 'checkbox'
    checkbox.disabled = Boolean(post.imported)
    checkbox.checked = !post.imported && facebookPostBrowser.selected.has(post.id)
    option.classList.toggle('selected', checkbox.checked)
    option.classList.toggle('imported', Boolean(post.imported))
    content.className = 'facebook-post-content'
    images.className = 'facebook-post-images'
    caption.className = 'facebook-post-caption'
    meta.className = 'facebook-post-meta'

    for (const [index, imageData] of post.images.entries()) {
      const image = document.createElement('img')
      image.src = imageData.imageUrl
      image.alt = `รูปตัวอย่าง ${index + 1} ของโพสต์ ${post.id}`
      image.loading = 'lazy'
      images.append(image)
    }

    caption.textContent = post.message || '(ไม่มี caption)'
    postId.textContent = post.id
    date.textContent = formatPostDate(post.createdTime)
    meta.append(postId, date)
    if (post.imported) {
      importedBadge.className = 'facebook-post-imported'
      importedBadge.textContent = 'นำเข้าแล้ว'
      meta.append(importedBadge)
    }
    content.append(images, caption, meta)
    option.append(checkbox, content)

    checkbox.addEventListener('change', () => {
      if (checkbox.checked) facebookPostBrowser.selected.add(post.id)
      else facebookPostBrowser.selected.delete(post.id)
      option.classList.toggle('selected', checkbox.checked)
      updateSelectedPostCount()
    })
    facebookPostList.append(option)
  }

  emptyFacebookPosts.hidden = facebookPostBrowser.posts.length > 0
  previousFacebookPosts.disabled = facebookPostBrowser.pageIndex === 0
  nextFacebookPosts.disabled = !facebookPostBrowser.hasNext
  facebookPostPage.textContent = `หน้า ${facebookPostBrowser.pageIndex + 1}`
  updateSelectedPostCount()
}

async function loadFacebookPosts() {
  const cursor = facebookPostBrowser.cursors[facebookPostBrowser.pageIndex] || ''
  facebookPostList.innerHTML = '<p class="browse-empty">กำลังโหลดโพสต์จาก Facebook…</p>'
  emptyFacebookPosts.hidden = true
  previousFacebookPosts.disabled = true
  nextFacebookPosts.disabled = true
  importError.hidden = true

  try {
    const query = cursor ? `?after=${encodeURIComponent(cursor)}` : ''
    const data = await requestJson(`/api/facebook/posts${query}`)
    facebookPostBrowser.posts = data.posts || []
    facebookPostBrowser.nextCursor = data.paging?.after || null
    facebookPostBrowser.hasNext = Boolean(data.paging?.hasNext && data.paging?.after)
    facebookPostBrowser.loaded = true
    renderFacebookPosts()
  } catch (error) {
    facebookPostList.replaceChildren()
    importError.textContent = error.message || 'โหลดโพสต์จาก Facebook ไม่สำเร็จ'
    importError.hidden = false
  }
}

function setImportMode(mode) {
  const browse = mode === 'browse'
  linkImportPanel.hidden = browse
  browseImportPanel.hidden = !browse
  form.elements.postId.required = !browse
  document.querySelectorAll('[data-import-tab]').forEach((tab) => {
    const active = tab.dataset.importTab === mode
    tab.classList.toggle('active', active)
    tab.setAttribute('aria-selected', String(active))
  })
  importError.hidden = true

  if (browse && !facebookPostBrowser.loaded) loadFacebookPosts()
  if (!browse) requestAnimationFrame(() => form.elements.postId.focus())
}

function openImportDialog() {
  facebookPostBrowser.cursors = ['']
  facebookPostBrowser.pageIndex = 0
  facebookPostBrowser.nextCursor = null
  facebookPostBrowser.hasNext = false
  facebookPostBrowser.posts = []
  facebookPostBrowser.selected.clear()
  facebookPostBrowser.loaded = false
  setImportMode('link')
  importError.hidden = true
  dialog.showModal()
  requestAnimationFrame(() => document.querySelector('#postId').focus())
}

async function checkApi() {
  try {
    const response = await fetch('/api/health')
    const data = await response.json()
    const label = data.facebookConfigured
      ? `เชื่อมต่อแล้ว — ${data.facebookProfile?.name || 'Facebook Page'}`
      : 'Login with Facebook'

    document.querySelectorAll('[data-connection-label]').forEach((element) => {
      element.textContent = label
    })
    document.querySelector('#brandName').textContent = data.facebookConfigured
      ? data.facebookProfile?.name || 'Facebook Page'
      : 'face-shelf'
    document.querySelectorAll('[data-open-settings]').forEach((button) => {
      button.classList.toggle('connected', data.facebookConfigured)
      button.querySelector('.status-dot')?.classList.toggle('ready', data.facebookConfigured)
    })
    settingsForm.elements.version.value = data.graphVersion || 'v26.0'
    return data
  } catch {
    document.querySelectorAll('[data-connection-label]').forEach((element) => {
      element.textContent = 'Server ไม่พร้อมใช้งาน'
    })
    return null
  }
}

document.querySelectorAll('.filter').forEach((button) => {
  button.addEventListener('click', () => {
    document.querySelector('.filter.active').classList.remove('active')
    button.classList.add('active')
    state.filter = button.dataset.filter
    render()
  })
})

document.querySelector('#searchInput').addEventListener('input', (event) => {
  state.search = event.target.value.trim()
  render()
})

document.querySelector('#postSort').addEventListener('change', (event) => {
  state.postSort = event.target.value
  renderPostList()
})

document.querySelector('#openImport').addEventListener('click', openImportDialog)
document.querySelectorAll('[data-import-tab]').forEach((tab) => {
  tab.addEventListener('click', () => setImportMode(tab.dataset.importTab))
})
document.querySelector('#reloadFacebookPosts').addEventListener('click', loadFacebookPosts)
previousFacebookPosts.addEventListener('click', () => {
  if (facebookPostBrowser.pageIndex === 0) return
  facebookPostBrowser.pageIndex -= 1
  loadFacebookPosts()
})
nextFacebookPosts.addEventListener('click', () => {
  if (!facebookPostBrowser.hasNext || !facebookPostBrowser.nextCursor) return
  facebookPostBrowser.cursors[facebookPostBrowser.pageIndex + 1] = facebookPostBrowser.nextCursor
  facebookPostBrowser.pageIndex += 1
  loadFacebookPosts()
})
importSelectedPosts.addEventListener('click', async () => {
  const postIds = [...facebookPostBrowser.selected]
  if (postIds.length === 0) return

  importSelectedPosts.disabled = true
  importError.hidden = true
  let importedCount = 0
  const errors = []

  for (let index = 0; index < postIds.length; index += 1) {
    importSelectedPosts.textContent = `กำลังนำเข้า ${index + 1}/${postIds.length}…`
    try {
      const data = await requestJson('/api/facebook/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ postId: postIds[index], skipExisting: true })
      })
      replaceImportedPost(data)
      facebookPostBrowser.selected.delete(postIds[index])
      importedCount += 1
    } catch (error) {
      if (error.message === 'โพสต์นี้ถูกนำเข้าแล้ว') {
        facebookPostBrowser.selected.delete(postIds[index])
      } else {
        errors.push(error.message)
      }
    }
  }

  render()
  await loadFacebookPosts()
  updateSelectedPostCount(importedCount > 0 ? `นำเข้าสำเร็จ ${importedCount} โพสต์` : '')
  importSelectedPosts.textContent = 'นำเข้าโพสต์ที่เลือก'
  importSelectedPosts.disabled = facebookPostBrowser.selected.size === 0

  if (errors.length > 0) {
    importError.textContent = `นำเข้าบางโพสต์ไม่สำเร็จ: ${errors[0]}`
    importError.hidden = false
  }
})
document.querySelector('#showAllPosts').addEventListener('click', (event) => {
  event.preventDefault()
  state.postId = null
  render()
})
document.querySelector('a[href="#import"]').addEventListener('click', (event) => {
  event.preventDefault()
  openImportDialog()
})
document.querySelector('#clearLocalCache').addEventListener('click', async () => {
  const confirmed = window.confirm('ล้างรายการโพสต์ สินค้า และสถานะทั้งหมดออกจากระบบ?')
  if (!confirmed) return

  try {
    await requestJson('/api/data', { method: 'DELETE' })
    state.products = []
    state.postId = null
    state.filter = 'all'
    state.search = ''
    state.postSort = 'date'
    document.querySelector('#searchInput').value = ''
    document.querySelector('#postSort').value = 'date'
    document.querySelector('.filter.active')?.classList.remove('active')
    document.querySelector('[data-filter="all"]').classList.add('active')
    render()
  } catch (error) {
    showErrorDialog('ล้างข้อมูลไม่สำเร็จ', error.message)
  }
})
document.querySelector('#closeImport').addEventListener('click', () => dialog.close())
document.querySelectorAll('[data-open-settings]').forEach((button) => {
  button.addEventListener('click', () => {
    settingsError.hidden = true
    settingsDialog.showModal()
    requestAnimationFrame(() => settingsForm.elements.accessToken.focus())
  })
})
document.querySelector('#closeSettings').addEventListener('click', () => settingsDialog.close())
document.querySelector('#closeConnectionError').addEventListener('click', () => connectionErrorDialog.close())
document.querySelector('#loginFacebook').addEventListener('click', () => {
  window.location.href = '/auth/facebook'
})
document.querySelector('#cancelSoldOut').addEventListener('click', () => {
  pendingSoldProduct = null
  soldConfirmDialog.close()
})
document.querySelector('#confirmSoldOut').addEventListener('click', async () => {
  if (pendingSoldProduct) {
    const product = pendingSoldProduct
    const previous = product.sold
    product.sold = true
    try {
      await persistProduct(product)
      render()
    } catch (error) {
      product.sold = previous
      showErrorDialog('อัปเดตสถานะไม่สำเร็จ', error.message)
    }
  }
  pendingSoldProduct = null
  soldConfirmDialog.close()
})

function applySyncedProducts(data) {
  const statusByPhotoId = new Map(data.items.map((item) => [item.facebookPhotoId, item]))
  for (const product of state.products) {
    const synced = statusByPhotoId.get(product.facebookPhotoId)
    if (!synced) continue
    product.caption = synced.caption
    product.sold = synced.sold
  }
}

async function syncProductSet(products) {
  const photoIds = [...new Set(
    products.map((product) => product.facebookPhotoId).filter(Boolean)
  )]

  if (photoIds.length === 0) return { items: [], updated: 0, skipped: 0 }

  const data = await requestJson('/api/facebook/sync', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ photoIds })
  })
  applySyncedProducts(data)
  return data
}

document.querySelector('#syncSelectedPost').addEventListener('click', async (event) => {
  const button = event.currentTarget
  const products = state.products.filter((product) => (
    product.postId === state.postId && !product.isArtwork
  ))

  if (products.length === 0) {
    showErrorDialog('ยังไม่มีรายการสำหรับ Sync', 'โพสต์นี้ไม่มีสินค้าให้ Sync')
    return
  }

  button.disabled = true
  button.textContent = 'กำลัง Sync โพสต์นี้…'

  try {
    const data = await syncProductSet(products)
    render()
    button.textContent = `✓ Sync แล้ว ${data.updated ?? data.items.length} ชิ้น`
    if (data.skipped > 0) {
      showErrorDialog(
        'Sync ได้ไม่ครบทุกชิ้น',
        `อัปเดตสำเร็จ ${data.updated} ชิ้น และ Facebook ไม่ส่ง caption กลับมา ${data.skipped} ชิ้น`
      )
    }
  } catch (error) {
    button.textContent = '↻ Sync โพสต์นี้'
    showErrorDialog('Sync sold out ไม่สำเร็จ', error.message || 'กรุณาตรวจการเชื่อมต่อ Facebook')
  } finally {
    button.disabled = false
    setTimeout(() => { button.textContent = '↻ Sync โพสต์นี้' }, 1800)
  }
})

document.querySelector('#syncAllPosts').addEventListener('click', async (event) => {
  const button = event.currentTarget
  const groups = getPostGroups().filter((group) => group.products.length > 0)

  if (groups.length === 0) {
    showErrorDialog('ยังไม่มีรายการสำหรับ Sync', 'กรุณานำเข้าโพสต์ Facebook ก่อน')
    return
  }

  button.disabled = true
  let updated = 0
  let skipped = 0
  const errors = []

  for (let index = 0; index < groups.length; index += 1) {
    button.textContent = `↻ Sync ${index + 1}/${groups.length} โพสต์…`
    try {
      const data = await syncProductSet(groups[index].products)
      updated += data.updated ?? data.items.length
      skipped += data.skipped || 0
    } catch (error) {
      errors.push(`${groups[index].postId}: ${error.message}`)
    }
  }

  render()
  button.disabled = false
  button.textContent = `✓ Sync แล้ว ${groups.length - errors.length}/${groups.length} โพสต์`
  setTimeout(() => { button.innerHTML = '<span>↻</span> Sync sold out ทุกโพสต์' }, 2200)

  if (errors.length > 0 || skipped > 0) {
    const details = []
    if (errors.length > 0) details.push(`ล้มเหลว ${errors.length} โพสต์`)
    if (skipped > 0) details.push(`Facebook ไม่ส่ง caption ${skipped} ชิ้น`)
    showErrorDialog('Sync ได้ไม่ครบทุกโพสต์', details.join(' · '))
  }
})

settingsForm.addEventListener('submit', async (event) => {
  event.preventDefault()
  const submit = document.querySelector('#submitSettings')
  submit.disabled = true
  submit.textContent = 'กำลังตรวจสอบ…'
  settingsError.hidden = true

  try {
    const response = await fetch('/api/facebook/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        accessToken: settingsForm.elements.accessToken.value,
        version: settingsForm.elements.version.value
      })
    })
    const data = await response.json()
    if (!response.ok) throw new Error(data.error)

    settingsForm.elements.accessToken.value = ''
    settingsDialog.close()
    await checkApi()
    await refreshProducts()
  } catch (error) {
    showErrorDialog(
      'เชื่อมต่อ Facebook ไม่สำเร็จ',
      error.message || 'กรุณาตรวจสอบ Access Token และ permission แล้วลองอีกครั้ง'
    )
  } finally {
    submit.disabled = false
    submit.textContent = 'ตรวจสอบและเชื่อมต่อ'
  }
})

async function handleFacebookOAuthResult() {
  const params = new URLSearchParams(window.location.search)
  const error = params.get('facebook_error')
  const connected = params.get('facebook_connected')
  const loginId = params.get('facebook_pages')

  if (!error && !connected && !loginId) return false
  history.replaceState({}, '', window.location.pathname)

  if (error) {
    showErrorDialog('Login with Facebook ไม่สำเร็จ', error)
    return true
  }

  if (connected) {
    await checkApi()
    await refreshProducts()
    return true
  }

  try {
    const response = await fetch(`/api/facebook/pages?login=${encodeURIComponent(loginId)}`)
    const data = await response.json()
    if (!response.ok) throw new Error(data.error)

    pagePickerList.replaceChildren()
    for (const page of data.pages) {
      const button = document.createElement('button')
      button.className = 'page-option'
      button.type = 'button'
      button.innerHTML = `<div><strong></strong><small></small></div><span>เลือก →</span>`
      button.querySelector('strong').textContent = page.name
      button.querySelector('small').textContent = page.category || `Page ID: ${page.id}`
      button.addEventListener('click', async () => {
        button.disabled = true
        const selectResponse = await fetch('/api/facebook/select-page', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ loginId, pageId: page.id })
        })
        const selectData = await selectResponse.json()
        if (!selectResponse.ok) {
          button.disabled = false
          showErrorDialog('เลือก Facebook Page ไม่สำเร็จ', selectData.error)
          return
        }
        pagePickerDialog.close()
        await checkApi()
        await refreshProducts()
      })
      pagePickerList.append(button)
    }
    pagePickerDialog.showModal()
  } catch (oauthError) {
    showErrorDialog('ดึงรายการ Facebook Page ไม่สำเร็จ', oauthError.message)
  }
  return true
}

form.addEventListener('submit', async (event) => {
  event.preventDefault()
  const postId = form.elements.postId.value.trim()
  if (!postId) {
    importError.textContent = 'กรุณาวางลิงก์ Facebook หรือ Post ID'
    importError.hidden = false
    return
  }
  const submit = document.querySelector('#submitImport')
  submit.disabled = true
  submit.textContent = 'กำลังดึงข้อมูล…'
  importError.hidden = true

  try {
    const data = await requestJson('/api/facebook/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ postId })
    })

    replaceImportedPost(data)
    state.postId = data.post.id
    render()
    form.reset()
    dialog.close()
  } catch (error) {
    importError.textContent = error.message || 'นำเข้าโพสต์ไม่สำเร็จ'
    importError.hidden = false
  } finally {
    submit.disabled = false
    submit.textContent = 'ดึงรูปสินค้า'
  }
})

async function initialize() {
  render()
  const handledOAuth = await handleFacebookOAuthResult()
  if (handledOAuth) return
  const health = await checkApi()
  if (health?.facebookConfigured) await refreshProducts()
}

initialize()
