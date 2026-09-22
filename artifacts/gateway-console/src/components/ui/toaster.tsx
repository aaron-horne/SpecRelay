import { useToast } from "@/hooks/use-toast"
import { Toaster as RadixToaster } from "@/components/ui/toast"

export function Toaster() {
  const { toasts } = useToast()
  return <RadixToaster toasts={toasts} />
}
