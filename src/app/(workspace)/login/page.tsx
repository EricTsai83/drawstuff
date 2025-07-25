import { LoginForm } from "@/components/login-form";
import { SignInOverlayModal } from "@/components/sign-in-overlay-modal";

export default function LoginPage() {
  return (
    <SignInOverlayModal>
      <LoginForm />
    </SignInOverlayModal>
  );
}
