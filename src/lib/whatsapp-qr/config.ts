/** Interruptor general. Sin `WHATSAPP_QR_ENABLED=true` nada del QR corre. */
export function qrHabilitado(): boolean {
  return process.env.WHATSAPP_QR_ENABLED === 'true'
}
