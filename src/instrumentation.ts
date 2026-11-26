export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    if (process.env.WHATSAPP_QR_ENABLED !== 'true') return
    const { supervisar } = await import('@/lib/whatsapp-qr/manager')
    // Sin await: el servidor no debe esperar a WhatsApp para arrancar.
    void supervisar()
  }
}
