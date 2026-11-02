const state = {
  products: [],
  events: [],
  eventId: null,
  filter: 'all',
  search: '',
  postId: null,
  postSort: 'date',
  pageProfile: null
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
const pageSettingsForm = document.querySelector('#pageSettingsForm')
const pageSettingsError = document.querySelector('#pageSettingsError')
const connectionErrorDialog = document.querySelector('#connectionErrorDialog')
const connectionErrorMessage = document.querySelector('#connectionErrorMessage')
const errorDialogTitle = document.querySelector('#errorDialogTitle')
const soldConfirmDialog = document.querySelector('#soldConfirmDialog')
const syncResultDialog = document.querySelector('#syncResultDialog')
const syncResultTitle = document.querySelector('#syncResultTitle')
const syncResultBreakdown = document.querySelector('#syncResultBreakdown')
const syncResultNote = document.querySelector('#syncResultNote')
const productPreviewDialog = document.querySelector('#productPreviewDialog')
const productPreviewImage = document.querySelector('#productPreviewImage')
const productPreviewPostLink = document.querySelector('#productPreviewPostLink')
const pagePickerDialog = document.querySelector('#pagePickerDialog')
const pagePickerList = document.querySelector('#pagePickerList')
const sidebar = document.querySelector('.sidebar')
const mobileMenuToggle = document.querySelector('.mobile-menu-toggle')
const mobileMenuClose = document.querySelector('.mobile-menu-close')
const sidebarBackdrop = document.querySelector('.sidebar-backdrop')
const mobileMenuMedia = window.matchMedia('(max-width: 760px)')
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
const eventDialog = document.querySelector('#eventDialog')
const eventForm = document.querySelector('#eventForm')
let editingEventId = null
let pendingSoldProduct = null

function setMobileMenu(open) {
  const isOpen = open && mobileMenuMedia.matches
  sidebar.classList.toggle('open', isOpen)
  sidebarBackdrop.classList.toggle('visible', isOpen)
  document.body.classList.toggle('mobile-menu-open', isOpen)
  mobileMenuToggle.setAttribute('aria-expanded', String(isOpen))
  sidebar.inert = mobileMenuMedia.matches && !isOpen
  if (isOpen) mobileMenuClose.focus()
}

setMobileMenu(false)
mobileMenuToggle.addEventListener('click', () => setMobileMenu(true))
mobileMenuClose.addEventListener('click', () => setMobileMenu(false))
sidebarBackdrop.addEventListener('click', () => setMobileMenu(false))
sidebar.addEventListener('click', (event) => {
  if (window.innerWidth <= 760 && event.target.closest('.nav-item, .sidebar-foot, .post-item-main, .event-item, #createEvent, #importPost')) {
    setMobileMenu(false)
  }
})
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && sidebar.classList.contains('open')) setMobileMenu(false)
})
mobileMenuMedia.addEventListener('change', () => setMobileMenu(false))
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

function showSyncResult(summary, note = '') {
  syncResultTitle.textContent = `มีการเปลี่ยนแปลง ${summary.changed} รายการ`
  syncResultBreakdown.textContent = `sold out ${summary.soldOut} รายการ | อื่นๆ ${summary.other} รายการ`
  syncResultNote.textContent = note
  syncResultNote.hidden = !note
  syncResultDialog.showModal()
}

function openProductPreview(product) {
  productPreviewImage.src = product.imageUrl
  productPreviewImage.alt = `สินค้า ${product.id}`
  productPreviewPostLink.hidden = !product.targetUrl
  if (product.targetUrl) productPreviewPostLink.href = product.targetUrl
  else productPreviewPostLink.removeAttribute('href')
  productPreviewDialog.showModal()
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
  const [data, eventData] = await Promise.all([requestJson('/api/products'), requestJson('/api/events')])
  state.products = data.products || []
  state.events = eventData.events || []
  if (!state.events.some((event) => event.id === state.eventId)) state.eventId = null
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

function resetProductState() {
  state.products = []
  if (!state.pageProfile) state.events = []
  state.eventId = null
  state.postId = null
  state.filter = 'all'
  state.search = ''
  state.postSort = 'date'
  document.querySelector('#searchInput').value = ''
  document.querySelector('#postSort').value = 'date'
  document.querySelector('.filter.active')?.classList.remove('active')
  document.querySelector('[data-filter="all"]').classList.add('active')
  render()
}

function visibleProducts() {
  return state.products.filter((product) => {
    const matchesStatus = state.filter === 'artwork'
      ? product.isArtwork
      : !product.isArtwork && (state.filter === 'all' || (state.filter === 'sold' ? product.sold : !product.sold))
    const matchesSearch = product.id.toLowerCase().includes(state.search.toLowerCase())
    const matchesPost = !state.postId || product.postId === state.postId
    const matchesEvent = !state.eventId || (product.eventIds || []).includes(state.eventId)
    return matchesStatus && matchesSearch && matchesPost && matchesEvent
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
  const existingProducts = state.products.filter((product) => product.postId === data.post.id)
  const existingByPhotoId = new Map(
    existingProducts.filter((product) => product.facebookPhotoId)
      .map((product) => [product.facebookPhotoId, product])
  )
  const existingById = new Map(existingProducts.map((product) => [product.id, product]))
  const imported = data.products.map((product, index) => {
    const id = `${data.post.id}-${String(index + 1).padStart(2, '0')}`
    const existing = existingByPhotoId.get(product.facebookPhotoId) || existingById.get(id)
    return {
      ...product,
      id,
      postId: data.post.id,
      postCreatedTime: data.post.createdTime || existing?.postCreatedTime || '',
      isArtwork: product.isArtwork || existing?.isArtwork || false
    }
  })

  state.products = [
    ...imported,
    ...state.products.filter((product) => product.postId !== data.post.id)
  ]
  return imported
}

async function refreshPost(postId) {
  const data = await requestJson('/api/facebook/import', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ postId })
  })
  return replaceImportedPost(data)
}

async function updatePost(group, button) {
  button.disabled = true
  button.textContent = 'กำลัง Update…'

  try {
    await refreshPost(group.postId)
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
  document.querySelector('#showAllPosts').classList.toggle('active', !state.postId && !state.eventId)

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
      state.eventId = null
      state.postId = state.postId === group.postId ? null : group.postId
      render()
    })
    item.querySelector('.post-update').addEventListener('click', (event) => {
      event.preventDefault()
      updatePost(group, event.currentTarget)
    })
    item.querySelector('.post-copy-stock').addEventListener('click', async (event) => {
      event.preventDefault()
      const button = event.currentTarget
      const stockUrl = new URL(
        `/${encodeURIComponent(state.pageProfile.id)}/stocks/${encodeURIComponent(group.postId)}`,
        window.location.origin
      ).href

      try {
        await navigator.clipboard.writeText(stockUrl)
        button.textContent = 'Copied!'
        window.setTimeout(() => { button.textContent = 'Copy URL available' }, 1_500)
      } catch {
        window.prompt('Copy URL available', stockUrl)
      }
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
    !product.isArtwork && (!state.postId || product.postId === state.postId) &&
    (!state.eventId || (product.eventIds || []).includes(state.eventId))
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

    const imageWrap = card.querySelector('.image-wrap')
    if (product.width > 0 && product.height > 0) {
      imageWrap.style.aspectRatio = `${product.width} / ${product.height}`
    }

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

    imageWrap.setAttribute('role', 'button')
    imageWrap.setAttribute('tabindex', '0')
    imageWrap.setAttribute('aria-label', `ดูรูปสินค้า ${product.id}`)
    imageWrap.addEventListener('click', () => openProductPreview(product))
    imageWrap.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return
      event.preventDefault()
      openProductPreview(product)
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

    for (const event of state.events) {
      const included = (product.eventIds || []).includes(event.id)
      if (included) {
        const badge = document.createElement('span')
        badge.className = 'event-badge'
        badge.textContent = event.tag || event.name
        badge.style.color = event.tagColor || '#ffffff'
        badge.style.backgroundColor = event.tagBackgroundColor || '#256f4a'
        card.querySelector('.event-badges').append(badge)
      }
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'event-product-toggle'
      button.textContent = `${included ? '− เอาออกจาก' : '+ เพิ่มเข้า'} ${event.name}`
      button.addEventListener('click', async (clickEvent) => {
        clickEvent.preventDefault()
        button.disabled = true
        try {
          await requestJson(`/api/events/${encodeURIComponent(event.id)}/products/${encodeURIComponent(product.id)}`, {
            method: included ? 'DELETE' : 'PUT'
          })
          product.eventIds = included
            ? product.eventIds.filter((id) => id !== event.id)
            : [...(product.eventIds || []), event.id]
          render()
        } catch (error) {
          button.disabled = false
          showErrorDialog('จัดการสินค้าใน Event ไม่สำเร็จ', error.message)
        }
      })
      cardMenu.querySelector('.card-menu-popover').append(button)
    }

    toggle.hidden = Boolean(product.isArtwork)

    grid.append(card)
  }

  emptyState.hidden = products.length > 0
  updateSummary()
  renderPostList()
  renderEventList()
  document.querySelector('#syncSelectedPost').hidden = !state.postId
}

function renderEventList() {
  const list = document.querySelector('#eventList')
  list.replaceChildren()
  document.querySelector('#eventCount').textContent = state.events.length
  document.querySelector('#emptyEventList').hidden = state.events.length > 0
  document.querySelector('#createEvent').disabled = !state.pageProfile
  const selectedEvent = state.events.find((event) => event.id === state.eventId)
  document.querySelector('#eventDetails').hidden = !selectedEvent
  if (selectedEvent) {
    document.querySelector('#selectedEventName').textContent = selectedEvent.name
    document.querySelector('#selectedEventDescription').innerHTML = selectedEvent.descriptionHtml || ''
    document.querySelector('#eventStockLink').href = selectedEvent.stockUrl
  }
  for (const event of state.events) {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'nav-item nav-button event-item'
    button.classList.toggle('active', event.id === state.eventId)
    const name = document.createElement('span')
    name.textContent = event.name
    const count = document.createElement('small')
    count.textContent = state.products.filter((product) => (product.eventIds || []).includes(event.id) && !product.isArtwork).length
    button.append(name, count)
    button.addEventListener('click', () => {
      state.eventId = event.id
      state.postId = null
      state.filter = 'all'
      state.search = ''
      document.querySelector('#searchInput').value = ''
      document.querySelector('.filter.active')?.classList.remove('active')
      document.querySelector('[data-filter="all"]').classList.add('active')
      render()
    })
    list.append(button)
  }
}

let uploadingEventImage = false
const eventImageFile = document.querySelector('#eventImageFile')
const EVENT_IMAGE_MAX_BYTES = 200_000

async function prepareEventImage(file) {
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) throw new Error('รองรับรูป JPEG, PNG และ WebP เท่านั้น')
  if (file.size > 10 * 1024 * 1024) throw new Error('กรุณาเลือกรูปไม่เกิน 10 MB')
  if (file.size <= EVENT_IMAGE_MAX_BYTES) return file
  const url = URL.createObjectURL(file)
  try {
    const image = new Image()
    image.src = url
    await image.decode()
    const canvas = document.createElement('canvas')
    canvas.width = image.naturalWidth
    canvas.height = image.naturalHeight
    const context = canvas.getContext('2d')
    if (!context) throw new Error('เบราว์เซอร์ไม่รองรับการเตรียมรูป')
    context.drawImage(image, 0, 0, canvas.width, canvas.height)
    const encode = (quality) => new Promise((resolve) => canvas.toBlob(resolve, 'image/webp', quality))
    const highest = await encode(0.95)
    if (!highest) throw new Error('เตรียมรูปไม่สำเร็จ กรุณาลองรูปอื่น')
    if (highest.size <= EVENT_IMAGE_MAX_BYTES) return highest
    let best = await encode(0)
    if (!best || best.size > EVENT_IMAGE_MAX_BYTES) {
      throw new Error('บีบอัดรูปนี้ให้ไม่เกิน 200 KB โดยคงความละเอียดเดิมไม่ได้ กรุณาเลือกรูปอื่น')
    }
    // Keep the best quality found within the size limit; never change pixel dimensions.
    let lower = 0
    let upper = 0.95
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const quality = (lower + upper) / 2
      const candidate = await encode(quality)
      if (candidate && candidate.size <= EVENT_IMAGE_MAX_BYTES) {
        best = candidate
        lower = quality
      } else {
        upper = quality
      }
    }
    return best
  } finally {
    URL.revokeObjectURL(url)
  }
}

document.querySelector('#uploadEventImage').addEventListener('click', () => eventImageFile.click())
eventImageFile.addEventListener('change', async () => {
  const file = eventImageFile.files[0]
  if (!file || uploadingEventImage) return
  const textarea = eventForm.elements.description
  const start = textarea.selectionStart
  const end = textarea.selectionEnd
  const status = document.querySelector('#eventUploadStatus')
  const errorMessage = document.querySelector('#eventError')
  const buttons = ['#uploadEventImage', '#saveEvent', '#closeEvent'].map((selector) => document.querySelector(selector))
  uploadingEventImage = true
  buttons.forEach((button) => { button.disabled = true })
  textarea.readOnly = true
  status.hidden = false
  status.textContent = 'กำลังบีบอัดรูปให้ไม่เกิน 200 KB และอัปโหลด…'
  errorMessage.hidden = true
  try {
    if (textarea.value.length - (end - start) + 100 > textarea.maxLength) throw new Error('รายละเอียดใกล้ครบ 2,000 ตัวอักษร กรุณาลดข้อความก่อนใส่รูป')
    const blob = await prepareEventImage(file)
    const data = await requestJson('/api/events/images', {
      method: 'POST', headers: { 'Content-Type': blob.type }, body: blob
    })
    textarea.setRangeText(`\n![รูป Event](${data.image.url})\n`, start, end, 'end')
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
    status.textContent = `ใส่รูปแล้ว (${Math.ceil(blob.size / 1000)} KB) กดบันทึก Event เพื่อเผยแพร่`
    textarea.focus()
  } catch (error) {
    status.hidden = true
    errorMessage.textContent = error.message
    errorMessage.hidden = false
  } finally {
    uploadingEventImage = false
    buttons.forEach((button) => { button.disabled = false })
    textarea.readOnly = false
    eventImageFile.value = ''
  }
})
eventDialog.addEventListener('cancel', (event) => {
  if (uploadingEventImage) event.preventDefault()
})

let eventPreviewVersion = 0
let eventPreviewTimer

function updateEventTagPreview() {
  const badge = document.querySelector('#eventTagPreview')
  badge.textContent = eventForm.elements.tag.value.trim() || eventForm.elements.name.value.trim() || 'Event'
  badge.style.color = eventForm.elements.tagColor.value
  badge.style.backgroundColor = eventForm.elements.tagBackgroundColor.value
}

async function previewEventMarkdown() {
  const preview = document.querySelector('#eventMarkdownPreview')
  const version = ++eventPreviewVersion
  preview.textContent = 'กำลังโหลด preview…'
  try {
    const data = await requestJson('/api/events/preview', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ description: eventForm.elements.description.value })
    })
    if (version === eventPreviewVersion) preview.innerHTML = data.html || '<p>ยังไม่มีรายละเอียด</p>'
  } catch (error) {
    if (version === eventPreviewVersion) preview.textContent = error.message
  }
}

eventForm.addEventListener('input', (event) => {
  updateEventTagPreview()
  if (event.target !== eventForm.elements.description) return
  eventPreviewVersion += 1
  window.clearTimeout(eventPreviewTimer)
  if (!document.querySelector('#eventMarkdownPreview').hidden) {
    eventPreviewTimer = window.setTimeout(previewEventMarkdown, 300)
  }
})
document.querySelector('#toggleEventPreview').addEventListener('click', () => {
  const preview = document.querySelector('#eventMarkdownPreview')
  preview.hidden = !preview.hidden
  document.querySelector('#toggleEventPreview').setAttribute('aria-expanded', String(!preview.hidden))
  if (!preview.hidden) previewEventMarkdown()
})
eventDialog.addEventListener('close', () => {
  window.clearTimeout(eventPreviewTimer)
  eventPreviewVersion += 1
})

function openEventDialog(event = null) {
  editingEventId = event?.id || null
  document.querySelector('#eventUploadStatus').hidden = true
  eventImageFile.value = ''
  eventForm.elements.name.value = event?.name || ''
  eventForm.elements.description.value = event?.description || ''
  eventForm.elements.tag.value = event?.tag || ''
  eventForm.elements.tagColor.value = event?.tagColor || '#ffffff'
  eventForm.elements.tagBackgroundColor.value = event?.tagBackgroundColor || '#256f4a'
  eventPreviewVersion += 1
  document.querySelector('#eventMarkdownPreview').hidden = true
  document.querySelector('#toggleEventPreview').setAttribute('aria-expanded', 'false')
  updateEventTagPreview()
  document.querySelector('#eventDialogTitle').textContent = event ? 'แก้ไข Event' : 'สร้าง Event'
  document.querySelector('#eventError').hidden = true
  eventDialog.showModal()
}

document.querySelector('#createEvent').addEventListener('click', () => openEventDialog())
document.querySelector('#closeEvent').addEventListener('click', () => eventDialog.close())
document.querySelector('#editEvent').addEventListener('click', () => {
  const event = state.events.find((item) => item.id === state.eventId)
  if (event) openEventDialog(event)
})
eventForm.addEventListener('submit', async (event) => {
  event.preventDefault()
  if (uploadingEventImage) return
  const button = document.querySelector('#saveEvent')
  const errorMessage = document.querySelector('#eventError')
  button.disabled = true
  errorMessage.hidden = true
  try {
    const data = await requestJson(editingEventId ? `/api/events/${encodeURIComponent(editingEventId)}` : '/api/events', {
      method: editingEventId ? 'PATCH' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: eventForm.elements.name.value, description: eventForm.elements.description.value,
        tag: eventForm.elements.tag.value, tagColor: eventForm.elements.tagColor.value,
        tagBackgroundColor: eventForm.elements.tagBackgroundColor.value
      })
    })
    state.events = [data.event, ...state.events.filter((item) => item.id !== data.event.id)]
    state.eventId = data.event.id
    state.postId = null
    state.filter = 'all'
    state.search = ''
    document.querySelector('#searchInput').value = ''
    document.querySelector('.filter.active')?.classList.remove('active')
    document.querySelector('[data-filter="all"]').classList.add('active')
    eventDialog.close()
    render()
  } catch (error) {
    errorMessage.textContent = error.message
    errorMessage.hidden = false
  } finally {
    button.disabled = false
  }
})
document.querySelector('#deleteEvent').addEventListener('click', async (clickEvent) => {
  const event = state.events.find((item) => item.id === state.eventId)
  if (!event || !window.confirm(`ลบ Event “${event.name}”? สินค้าในร้านจะยังคงอยู่`)) return
  const button = clickEvent.currentTarget
  button.disabled = true
  try {
    await requestJson(`/api/events/${encodeURIComponent(event.id)}`, { method: 'DELETE' })
    state.events = state.events.filter((item) => item.id !== event.id)
    for (const product of state.products) product.eventIds = (product.eventIds || []).filter((id) => id !== event.id)
    state.eventId = null
    render()
  } catch (error) {
    showErrorDialog('ลบ Event ไม่สำเร็จ', error.message)
  } finally {
    button.disabled = false
  }
})

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
    state.pageProfile = data.facebookProfile || null

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
    const shopStockLink = document.querySelector('#shopStockLink')
    shopStockLink.hidden = !data.stockUrl
    if (data.stockUrl) shopStockLink.href = data.stockUrl
    settingsForm.elements.version.value = data.graphVersion || 'v26.0'
    pageSettingsForm.elements.description.value = data.pageSettings?.description || ''
    pageSettingsForm.elements.themeColor.value = data.pageSettings?.themeColor || '#256f4a'
    document.querySelector('#themeColorValue').textContent = pageSettingsForm.elements.themeColor.value
    pageSettingsForm.hidden = !data.facebookConfigured
    document.querySelector('.danger-zone').hidden = !data.facebookConfigured
    const pageName = data.facebookProfile?.name || 'Page'
    document.querySelector('#deletePageTitle').textContent = `ล้างข้อมูล Page - ${pageName}`
    document.querySelector('#deletePageData').textContent = `ล้างข้อมูล Page - ${pageName}`
    return data
  } catch {
    document.querySelector('#shopStockLink').hidden = true
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
  state.eventId = null
  render()
})
document.querySelector('#importPost').addEventListener('click', (event) => {
  event.preventDefault()
  openImportDialog()
})
document.querySelector('#clearProductData').addEventListener('click', async () => {
  const confirmed = window.confirm('ล้างรายการโพสต์ สินค้า และสถานะทั้งหมดออกจากระบบ?')
  if (!confirmed) return

  try {
    await requestJson('/api/data', { method: 'DELETE' })
    resetProductState()
    settingsDialog.close()
  } catch (error) {
    showErrorDialog('ล้างข้อมูลไม่สำเร็จ', error.message)
  }
})
document.querySelector('#deletePageData').addEventListener('click', async () => {
  const pageName = state.pageProfile?.name || 'Page นี้'
  const confirmed = window.confirm(`ล้างข้อมูล Page - ${pageName} รวมการตั้งค่าและการเชื่อมต่อทั้งหมด?`)
  if (!confirmed) return

  try {
    await requestJson('/api/account', { method: 'DELETE' })
    state.pageProfile = null
    resetProductState()
    settingsDialog.close()
    await checkApi()
  } catch (error) {
    showErrorDialog('ล้างข้อมูล Page ไม่สำเร็จ', error.message)
  }
})
document.querySelector('#closeImport').addEventListener('click', () => dialog.close())
document.querySelector('#closeProductPreview').addEventListener('click', () => productPreviewDialog.close())
productPreviewDialog.addEventListener('click', (event) => {
  if (event.target === productPreviewDialog) productPreviewDialog.close()
})
productPreviewDialog.addEventListener('close', () => productPreviewImage.removeAttribute('src'))
document.querySelectorAll('[data-open-settings]').forEach((button) => {
  button.addEventListener('click', () => {
    settingsError.hidden = true
    pageSettingsError.hidden = true
    settingsDialog.showModal()
    requestAnimationFrame(() => {
      const target = state.pageProfile
        ? pageSettingsForm.elements.description
        : settingsForm.elements.accessToken
      target.focus()
    })
  })
})
document.querySelector('#closeSettings').addEventListener('click', () => settingsDialog.close())
document.querySelector('#closeConnectionError').addEventListener('click', () => connectionErrorDialog.close())
document.querySelector('#closeSyncResult').addEventListener('click', () => syncResultDialog.close())
document.querySelector('#loginFacebook').addEventListener('click', () => {
  window.location.href = '/auth/facebook'
})
document.querySelector('#themeColor').addEventListener('input', (event) => {
  document.querySelector('#themeColorValue').textContent = event.target.value
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
  const statusById = new Map(data.items.map((item) => [item.id, item]))
  const statusByPhotoId = new Map(
    data.items.filter((item) => item.facebookPhotoId).map((item) => [item.facebookPhotoId, item])
  )
  const summary = { changed: 0, soldOut: 0, other: 0 }
  for (const product of state.products) {
    const synced = statusById.get(product.id) || statusByPhotoId.get(product.facebookPhotoId)
    if (!synced) continue
    if (product.sold !== synced.sold || product.caption !== synced.caption) {
      summary.changed += 1
      if (synced.sold) summary.soldOut += 1
      else summary.other += 1
    }
    product.facebookPhotoId = synced.facebookPhotoId
    product.caption = synced.caption
    product.sold = synced.sold
  }
  return summary
}

function summarizeUpdatedPost(previousProducts, importedProducts) {
  const previousById = new Map(previousProducts.map((product) => [product.id, product]))
  const previousByPhotoId = new Map(
    previousProducts.filter((product) => product.facebookPhotoId)
      .map((product) => [product.facebookPhotoId, product])
  )
  const summary = { changed: 0, soldOut: 0, other: 0 }

  for (const product of importedProducts) {
    if (product.isArtwork) continue
    const previous = previousByPhotoId.get(product.facebookPhotoId) || previousById.get(product.id)
    if (!previous || (previous.sold === product.sold && previous.caption === product.caption)) continue
    summary.changed += 1
    if (product.sold) summary.soldOut += 1
    else summary.other += 1
  }
  return summary
}

async function syncProductSet(products) {
  const photoIds = [...new Set(
    products.map((product) => product.facebookPhotoId).filter(Boolean)
  )]

  const postIds = [...new Set(
    products.map((product) => product.postId).filter(Boolean)
  )]

  if (photoIds.length === 0 && postIds.length === 0) {
    return {
      items: [],
      updated: 0,
      skipped: 0,
      summary: { changed: 0, soldOut: 0, other: 0 }
    }
  }

  const data = await requestJson('/api/facebook/sync', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ photoIds, postIds })
  })
  return { ...data, summary: applySyncedProducts(data) }
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
    const note = data.skipped > 0
      ? `Facebook ไม่ส่ง caption กลับมา ${data.skipped} รายการ`
      : ''
    showSyncResult(data.summary, note)
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
  const groups = getPostGroups()

  if (groups.length === 0) {
    showErrorDialog('ยังไม่มีรายการสำหรับ Sync', 'กรุณานำเข้าโพสต์ Facebook ก่อน')
    return
  }

  button.disabled = true
  const summary = { changed: 0, soldOut: 0, other: 0 }
  const errors = []

  for (let index = 0; index < groups.length; index += 1) {
    button.textContent = `↻ Sync ${index + 1}/${groups.length} โพสต์…`
    try {
      const imported = await refreshPost(groups[index].postId)
      const postSummary = summarizeUpdatedPost(groups[index].products, imported)
      summary.changed += postSummary.changed
      summary.soldOut += postSummary.soldOut
      summary.other += postSummary.other
    } catch (error) {
      errors.push(`${groups[index].postId}: ${error.message}`)
    }
  }

  render()
  button.disabled = false
  button.textContent = `✓ Sync แล้ว ${groups.length - errors.length}/${groups.length} โพสต์`
  setTimeout(() => { button.innerHTML = '<span>↻</span> Sync sold out ทุกโพสต์' }, 2200)

  const details = []
  if (errors.length > 0) details.push(`ล้มเหลว ${errors.length} โพสต์`)
  showSyncResult(summary, details.join(' · '))
})

pageSettingsForm.addEventListener('submit', async (event) => {
  event.preventDefault()
  const submit = document.querySelector('#savePageSettings')
  submit.disabled = true
  submit.textContent = 'กำลังบันทึก…'
  pageSettingsError.hidden = true

  try {
    await requestJson('/api/page/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        description: pageSettingsForm.elements.description.value,
        themeColor: pageSettingsForm.elements.themeColor.value
      })
    })
    submit.textContent = 'บันทึกแล้ว ✓'
    setTimeout(() => { submit.textContent = 'บันทึกการตั้งค่า' }, 1600)
  } catch (error) {
    pageSettingsError.textContent = error.message
    pageSettingsError.hidden = false
    submit.textContent = 'บันทึกการตั้งค่า'
  } finally {
    submit.disabled = false
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
    state.eventId = null
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
