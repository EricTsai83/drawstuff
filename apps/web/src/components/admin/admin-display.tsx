import { Badge } from "@/components/ui/badge";

export function formatAdminDate(value: Date | null, langCode: string) {
  if (!value) return "—";
  return new Intl.DateTimeFormat(langCode === "zh-TW" ? "zh-TW" : "en", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(value);
}

export function AdminStatusBadge({
  status,
  label,
}: {
  status: string;
  label: string;
}) {
  if (status === "succeeded" || status === "active") {
    return <Badge variant="secondary">{label}</Badge>;
  }
  if (status === "failed") {
    return <Badge variant="destructive">{label}</Badge>;
  }
  return <Badge variant="outline">{label}</Badge>;
}
