// ===========================================================================
// Formato de WhatsApp para los mensajes del bot.
//
// Este archivo era EL PORTERO: revisaba y corregia los numeros de cada
// mensaje antes de mandarlo. Se quito el 24-09 al pasar el bot a Sonnet 5
// (corregia cuentas que estaban bien). Solo queda el arreglo de formato.
// ===========================================================================

/**
 * Deja el mensaje con el formato que WhatsApp entiende.
 *
 * El modelo escribe Markdown normal (**negrita**), pero WhatsApp usa UN solo
 * asterisco. Resultado: al cliente le llegaban los asteriscos a la vista
 * ("**Resumen:**") y, lo grave, PEGADOS AL LINK DE PAGO:
 *
 *   **https://sp.pagalo.co/kaffeejager-roastery**
 *
 * Con esos asteriscos la direccion deja de funcionar al tocarla, y el cliente
 * que iba a pagar no puede. Un link roto es una venta perdida.
 */
export function formatoWhatsApp(texto: string): string {
  if (!texto) return texto
  let t = texto
  // 1. Un enlace envuelto en negrita pierde la negrita entera: un link no
  //    necesita resaltarse y las marcas lo rompen.
  t = t.replace(/\*{1,2}\s*(https?:\/\/[^\s*_~`]+)\s*\*{1,2}/g, '$1')
  // 2. Negrita de Markdown -> negrita de WhatsApp.
  t = t.replace(/\*\*([^*\n]+)\*\*/g, '*$1*')
  // 3. Cualquier marca que haya quedado pegada a un enlace.
  t = t.replace(/(https?:\/\/[^\s*_~`]+)[*_~`]+/g, '$1')
  // 4. Dobles sueltos que quedaron sin pareja.
  t = t.replace(/\*\*/g, '*')
  return t
}
