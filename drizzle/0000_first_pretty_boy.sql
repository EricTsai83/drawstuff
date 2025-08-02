CREATE TABLE "excalidraw-ericts_account" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp,
	"refresh_token_expires_at" timestamp,
	"scope" text,
	"password" text,
	"created_at" timestamp NOT NULL,
	"updated_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "excalidraw-ericts_category" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" varchar(100) NOT NULL,
	"created_at" timestamp NOT NULL,
	CONSTRAINT "excalidraw-ericts_category_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "excalidraw-ericts_project" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" varchar(255) NOT NULL,
	"description" text,
	"user_id" text NOT NULL,
	"created_at" timestamp NOT NULL,
	"updated_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "excalidraw-ericts_scene" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" varchar(255) NOT NULL,
	"description" text,
	"image" text,
	"project_id" uuid,
	"user_id" text NOT NULL,
	"last_updated" timestamp NOT NULL,
	"created_at" timestamp NOT NULL,
	"updated_at" timestamp NOT NULL,
	"is_archived" boolean NOT NULL
);
--> statement-breakpoint
CREATE TABLE "excalidraw-ericts_scene_category" (
	"id" uuid PRIMARY KEY NOT NULL,
	"scene_id" uuid NOT NULL,
	"category_id" uuid NOT NULL,
	"created_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "excalidraw-ericts_session" (
	"id" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp NOT NULL,
	"updated_at" timestamp NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" text NOT NULL,
	CONSTRAINT "excalidraw-ericts_session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "excalidraw-ericts_share_link" (
	"id" text PRIMARY KEY NOT NULL,
	"scene_data" text NOT NULL,
	"created_at" timestamp NOT NULL,
	"expires_at" timestamp,
	"is_active" boolean NOT NULL
);
--> statement-breakpoint
CREATE TABLE "excalidraw-ericts_user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean NOT NULL,
	"image" text,
	"created_at" timestamp NOT NULL,
	"updated_at" timestamp NOT NULL,
	CONSTRAINT "excalidraw-ericts_user_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "excalidraw-ericts_verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp,
	"updated_at" timestamp
);
--> statement-breakpoint
ALTER TABLE "excalidraw-ericts_account" ADD CONSTRAINT "excalidraw-ericts_account_user_id_excalidraw-ericts_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."excalidraw-ericts_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "excalidraw-ericts_project" ADD CONSTRAINT "excalidraw-ericts_project_user_id_excalidraw-ericts_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."excalidraw-ericts_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "excalidraw-ericts_scene" ADD CONSTRAINT "excalidraw-ericts_scene_project_id_excalidraw-ericts_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."excalidraw-ericts_project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "excalidraw-ericts_scene" ADD CONSTRAINT "excalidraw-ericts_scene_user_id_excalidraw-ericts_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."excalidraw-ericts_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "excalidraw-ericts_scene_category" ADD CONSTRAINT "excalidraw-ericts_scene_category_scene_id_excalidraw-ericts_scene_id_fk" FOREIGN KEY ("scene_id") REFERENCES "public"."excalidraw-ericts_scene"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "excalidraw-ericts_scene_category" ADD CONSTRAINT "excalidraw-ericts_scene_category_category_id_excalidraw-ericts_category_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."excalidraw-ericts_category"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "excalidraw-ericts_session" ADD CONSTRAINT "excalidraw-ericts_session_user_id_excalidraw-ericts_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."excalidraw-ericts_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "category_name_idx" ON "excalidraw-ericts_category" USING btree ("name");--> statement-breakpoint
CREATE INDEX "project_user_id_idx" ON "excalidraw-ericts_project" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "project_name_idx" ON "excalidraw-ericts_project" USING btree ("name");--> statement-breakpoint
CREATE INDEX "scene_user_id_idx" ON "excalidraw-ericts_scene" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "scene_project_id_idx" ON "excalidraw-ericts_scene" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "scene_name_idx" ON "excalidraw-ericts_scene" USING btree ("name");--> statement-breakpoint
CREATE INDEX "scene_last_updated_idx" ON "excalidraw-ericts_scene" USING btree ("last_updated");--> statement-breakpoint
CREATE INDEX "scene_category_scene_id_idx" ON "excalidraw-ericts_scene_category" USING btree ("scene_id");--> statement-breakpoint
CREATE INDEX "scene_category_category_id_idx" ON "excalidraw-ericts_scene_category" USING btree ("category_id");--> statement-breakpoint
CREATE INDEX "unique_scene_category_idx" ON "excalidraw-ericts_scene_category" USING btree ("scene_id","category_id");--> statement-breakpoint
CREATE INDEX "share_link_id_idx" ON "excalidraw-ericts_share_link" USING btree ("id");--> statement-breakpoint
CREATE INDEX "share_link_created_at_idx" ON "excalidraw-ericts_share_link" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "share_link_expires_at_idx" ON "excalidraw-ericts_share_link" USING btree ("expires_at");