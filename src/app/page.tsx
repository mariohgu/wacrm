import { redirect } from 'next/navigation'
import { DEFAULT_LANDING_PATH } from '@/lib/navigation'

export default function RootPage() {
  redirect(DEFAULT_LANDING_PATH)
}
