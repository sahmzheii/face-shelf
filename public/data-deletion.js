const button = document.querySelector('#deleteAccount')
const result = document.querySelector('#deleteResult')

button.addEventListener('click', async () => {
  const confirmed = window.confirm('ยืนยันลบ Page token, session, โพสต์ และสินค้าทั้งหมดอย่างถาวร?')
  if (!confirmed) return

  button.disabled = true
  result.hidden = true

  try {
    const response = await fetch('/api/account', { method: 'DELETE' })
    const data = await response.json()
    if (!response.ok) throw new Error(data.error || 'ลบข้อมูลไม่สำเร็จ')

    result.className = 'result success'
    result.textContent = `ลบข้อมูลเรียบร้อย รหัสยืนยัน: ${data.confirmationCode}`
    result.hidden = false
    button.hidden = true
  } catch (error) {
    result.className = 'result error'
    result.textContent = error.message === 'กรุณา Login with Facebook ก่อน'
      ? 'กรุณากลับไปหน้า Face Shelf และ Login with Facebook ก่อนลบข้อมูล'
      : error.message
    result.hidden = false
    button.disabled = false
  }
})
