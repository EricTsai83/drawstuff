import { OverlayModal } from "@/components/overlay-modal";
import { LoginForm } from "@/components/login-form";

export default function LoginPageContent() {
  return (
    <OverlayModal
      centerOverlay
      centerContent
      contentClassName="bg-background border-border mx-auto flex w-full max-w-sm flex-col items-center justify-center rounded-lg border px-4 py-8"
    >
      <LoginForm />
    </OverlayModal>
  );
}
