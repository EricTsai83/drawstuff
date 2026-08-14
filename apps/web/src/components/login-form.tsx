"use client";

import { cn } from "@/lib/utils";
import { useAppI18n } from "@/hooks/use-app-i18n";
import { GoogleSignInButton } from "./google-sign-in-button";

export function LoginForm({
  className,
  ...props
}: React.ComponentProps<"div">) {
  const { t } = useAppI18n();

  return (
    <div className={cn("flex flex-col gap-6", className)} {...props}>
      <form>
        <div className="flex flex-col items-center gap-6">
          <div className="flex flex-col items-center gap-2">
            <h1 className="text-xl font-bold">{t("auth.welcome")}</h1>
          </div>

          <GoogleSignInButton />
        </div>
      </form>
      <div className="text-muted-foreground *:[a]:hover:text-primary text-center text-xs text-balance *:[a]:underline *:[a]:underline-offset-4">
        {t("auth.agreement.click")} <a href="#">{t("auth.terms")}</a>{" "}
        {t("auth.and")} <a href="#">{t("auth.privacy")}</a>.
      </div>
    </div>
  );
}
