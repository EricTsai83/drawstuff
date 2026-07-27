"use client";

import { cn } from "@/lib/utils";
import { authClient } from "@/lib/auth/client";
import { GoogleSignInButton } from "./google-sign-in-button";
import { Card, CardContent } from "@/components/ui/card";

type AuthRequiredProps = {
  className?: string;
  title?: string;
  description?: string;
  showCard?: boolean;
} & React.ComponentProps<"div">;

export function AuthRequired({
  className,
  title = "Sign in required",
  description = "Please sign in to access this feature",
  showCard = true,
  ...props
}: AuthRequiredProps) {
  const { data: session, isPending } = authClient.useSession();

  // Don't render if user is authenticated or still loading
  if (isPending || session) {
    return null;
  }

  const content = (
    <div className="flex flex-col items-center gap-6 text-center">
      <div className="flex flex-col items-center gap-2">
        <h2 className="text-foreground text-xl font-bold">{title}</h2>
        <p className="text-muted-foreground max-w-md text-sm">{description}</p>
      </div>

      <GoogleSignInButton />

      <div className="text-muted-foreground *:[a]:hover:text-primary text-xs text-balance *:[a]:underline *:[a]:underline-offset-4">
        By signing in, you agree to our{" "}
        <a href="#" tabIndex={0} aria-label="Terms of Service">
          Terms of Service
        </a>{" "}
        and{" "}
        <a href="#" tabIndex={0} aria-label="Privacy Policy">
          Privacy Policy
        </a>
        .
      </div>
    </div>
  );

  if (showCard) {
    return (
      <div className={cn("flex justify-center", className)} {...props}>
        <Card className="w-full max-w-md">
          <CardContent>{content}</CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div
      className={cn("flex flex-col items-center justify-center p-6", className)}
      {...props}
    >
      {content}
    </div>
  );
}
