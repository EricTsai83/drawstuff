"use client";

import { useState } from "react";
import Link from "next/link";
import { SearchIcon, ShieldCheckIcon } from "lucide-react";

import { useAdminI18n } from "@/components/admin/admin-i18n";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { api } from "@/trpc/react";

/** User search and permissions; each row opens the user page. */
export function AdminUsers() {
  const { t } = useAdminI18n();
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [operatorsOnly, setOperatorsOnly] = useState(false);
  const users = api.admin.listUsers.useQuery({
    search,
    limit: 25,
    operatorsOnly,
  });

  return (
    <section aria-labelledby="users-heading">
      <Card>
        <CardHeader className="border-b">
          <div>
            <h2 id="users-heading" className="text-lg font-semibold">
              {t("users.title")}
            </h2>
            <p className="text-muted-foreground text-sm">
              {t("users.description")}
            </p>
          </div>
          <form
            className="mt-3 flex items-end gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              setSearch(searchInput.trim());
            }}
          >
            <FieldGroup className="max-w-lg">
              <Field>
                <FieldLabel htmlFor="admin-user-search" className="sr-only">
                  {t("users.searchLabel")}
                </FieldLabel>
                <Input
                  id="admin-user-search"
                  value={searchInput}
                  placeholder={t("users.searchPlaceholder")}
                  onChange={(event) => setSearchInput(event.target.value)}
                />
              </Field>
            </FieldGroup>
            <Button type="submit" variant="secondary">
              <SearchIcon data-icon="inline-start" aria-hidden="true" />
              {t("users.search")}
            </Button>
            <Button
              type="button"
              variant={operatorsOnly ? "secondary" : "ghost"}
              aria-pressed={operatorsOnly}
              onClick={() => setOperatorsOnly((value) => !value)}
            >
              <ShieldCheckIcon data-icon="inline-start" aria-hidden="true" />
              {t("users.operatorsOnly")}
            </Button>
          </form>
        </CardHeader>
        <CardContent>
          {users.isPending ? (
            <div className="text-muted-foreground flex min-h-32 items-center justify-center gap-2">
              <Spinner /> {t("users.loading")}
            </div>
          ) : users.isError ? (
            <p className="text-destructive py-8 text-center text-sm">
              {users.error.message}
            </p>
          ) : users.data.length === 0 ? (
            <p className="text-muted-foreground py-8 text-center text-sm">
              {t("users.empty")}
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("table.user")}</TableHead>
                  <TableHead>{t("table.permission")}</TableHead>
                  <TableHead className="text-right">
                    {t("table.scenes")}
                  </TableHead>
                  <TableHead className="text-right">
                    {t("table.activeRooms")}
                  </TableHead>
                  <TableHead className="text-right">
                    {t("table.actions")}
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {users.data.map((target) => (
                  <TableRow key={target.id}>
                    <TableCell>
                      <div className="max-w-80">
                        <p className="truncate font-medium">{target.name}</p>
                        <p className="text-muted-foreground truncate text-xs">
                          {target.email}
                        </p>
                      </div>
                    </TableCell>
                    <TableCell>
                      {target.isOperator ? (
                        <Badge variant="secondary">{t("role.operator")}</Badge>
                      ) : (
                        <Badge variant="outline">{t("role.user")}</Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {target.sceneCount}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {target.activeRoomCount}
                    </TableCell>
                    <TableCell className="text-right">
                      <Link
                        href={`/admin/users/${encodeURIComponent(target.id)}`}
                        className={buttonVariants({
                          variant: "outline",
                          size: "sm",
                        })}
                      >
                        {t("users.manage")}
                      </Link>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </section>
  );
}
