import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * Keeps a "Pago: …" tag on each contact in sync with their deal's payment
 * status, so the owner can filter the inbox by who hasn't paid. A contact
 * carries exactly one payment tag at a time (Pendiente | Por confirmar |
 * Pagado). Best-effort — never throws.
 */
const PAY_TAGS: Record<string, { name: string; color: string }> = {
  pendiente: { name: 'Pago: Pendiente', color: '#ef4444' },
  porconfirmar: { name: 'Pago: Por confirmar', color: '#f59e0b' },
  pagado: { name: 'Pago: Pagado', color: '#22c55e' },
}

function classify(status: string | null | undefined): keyof typeof PAY_TAGS | null {
  const s = (status || '').toLowerCase()
  if (s.includes('pagad')) return 'pagado'
  if (s.includes('confirmar')) return 'porconfirmar'
  if (s.includes('pendiente')) return 'pendiente'
  return null
}

export async function syncPaymentTag(
  db: SupabaseClient,
  args: {
    accountId: string
    userId?: string | null
    contactId: string
    paymentStatus: string | null | undefined
  },
): Promise<void> {
  try {
    const key = classify(args.paymentStatus)
    if (!key) return
    const def = PAY_TAGS[key]

    // Find-or-create the target tag (created once; then reused).
    let { data: tag } = await db
      .from('tags')
      .select('id')
      .eq('account_id', args.accountId)
      .eq('name', def.name)
      .maybeSingle()
    if (!tag) {
      const ins = await db
        .from('tags')
        .insert({
          account_id: args.accountId,
          user_id: args.userId ?? null,
          name: def.name,
          color: def.color,
        })
        .select('id')
        .maybeSingle()
      tag = ins.data ?? null
    }
    if (!tag) return

    // Drop any other "Pago: …" tag from this contact, then add the current.
    const { data: allPay } = await db
      .from('tags')
      .select('id')
      .eq('account_id', args.accountId)
      .like('name', 'Pago: %')
    const otherIds = (allPay ?? [])
      .map((t) => t.id as string)
      .filter((id) => id !== tag!.id)
    if (otherIds.length) {
      await db
        .from('contact_tags')
        .delete()
        .eq('contact_id', args.contactId)
        .in('tag_id', otherIds)
    }
    await db
      .from('contact_tags')
      .upsert(
        { contact_id: args.contactId, tag_id: tag.id },
        { onConflict: 'contact_id,tag_id' },
      )
  } catch (err) {
    console.error('[payment-tags] sync failed:', err)
  }
}
