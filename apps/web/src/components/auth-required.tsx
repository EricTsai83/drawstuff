"use client";

import { cn } from "@/lib/utils";
import { authClient } from "@/lib/auth/client";
import { GoogleSignInButton } from "./google-sign-in-button";
import { Card, CardContent } from "@/components/ui/card";
import { useAppI18n } from "@/hooks/use-app-i18n";

type AuthRequiredProps = {
  className?: string;
  title?: string;
  description?: string;
  showCard?: boolean;
} & React.ComponentProps<"div">;

export function AuthRequired({
  className,
  title,
  description,
  showCard = true,
  ...props
}: AuthRequiredProps) {
  const { t } = useAppI18n();
  const { data: session, isPending } = authClient.useSession();
  const resolvedTitle = title ?? t("auth.required.title");
  const resolvedDescription = description ?? t("auth.required.description");

  // Don't render if user is authenticated or still loading
  if (isPending || session) {
    return null;
  }

  const content = (
    <div className="flex flex-col items-center gap-6 text-center">
      <div className="flex flex-col items-center gap-2">
        <h2 className="text-foreground text-xl font-bold">{resolvedTitle}</h2>
        <p className="text-muted-foreground max-w-md text-sm">
          {resolvedDescription}
        </p>
      </div>

      <GoogleSignInButton />

      <div className="text-muted-foreground *:[a]:hover:text-primary text-xs text-balance *:[a]:underline *:[a]:underline-offset-4">
        {t("auth.agreement.signIn")}{" "}
        <a href="#" tabIndex={0} aria-label={t("auth.terms")}>
          {t("auth.terms")}
        </a>{" "}
        {t("auth.and")}{" "}
        <a href="#" tabIndex={0} aria-label={t("auth.privacy")}>
          {t("auth.privacy")}
        </a>
        .
      </div>
    </div>
  );

  if (showCard) {
    return (
      <div
        className={cn("flex justify-center px-4 sm:px-6", className)}
        {...props}
      >
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
