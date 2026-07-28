import { cn } from "@/lib/utils";
import { GoogleSignInButton } from "./google-sign-in-button";

export function LoginForm({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div className={cn("flex flex-col gap-6", className)} {...props}>
      <form>
        <div className="flex flex-col items-center gap-6">
          <div className="flex flex-col items-center gap-2">
            <h1 className="text-xl font-bold">
              Welcome to Excalidraw X Ericts
            </h1>
          </div>

          <GoogleSignInButton />
        </div>
      </form>
      <div className="text-muted-foreground *:[a]:hover:text-primary text-center text-xs text-balance *:[a]:underline *:[a]:underline-offset-4">
        By clicking continue, you agree to our <a href="#">Terms of Service</a>{" "}
        and <a href="#">Privacy Policy</a>.
      </div>
    </div>
  );
}
