-- Generated collaboration-only reset. Run ONLY in the P3 isolated maintenance window.
-- Export cleanup manifests and stop all writers before this transaction. No object deletion here.
BEGIN;
DROP TABLE IF EXISTS "drawstuff_collaboration_asset", "drawstuff_collaboration_creation_fence", "drawstuff_collaboration_lifecycle_registration", "drawstuff_collaboration_lifecycle_subject", "drawstuff_collaboration_operation", "drawstuff_collaboration_projection_tombstone", "drawstuff_collaboration_room", "drawstuff_collaboration_room_member", "drawstuff_collaboration_snapshot", "drawstuff_collaboration_control_outbox";
CREATE TABLE "drawstuff_collaboration_asset" (
	"room_id" varchar(64) NOT NULL,
	"auth_generation" integer NOT NULL,
	"excalidraw_file_id" varchar(64) NOT NULL,
	"crypto_version" integer NOT NULL,
	"ut_file_key" varchar(256) NOT NULL,
	"url" varchar(512) NOT NULL,
	"byte_length" integer NOT NULL,
	"registered_by" text,
	"created_at" timestamp NOT NULL,
	CONSTRAINT "collaboration_asset_room_generation_file_pk" PRIMARY KEY("room_id","auth_generation","excalidraw_file_id"),
	CONSTRAINT "collaboration_asset_auth_generation_positive" CHECK ("drawstuff_collaboration_asset"."auth_generation" >= 1),
	CONSTRAINT "collaboration_asset_excalidraw_file_id_shape" CHECK ("drawstuff_collaboration_asset"."excalidraw_file_id" ~ '^[A-Za-z0-9_-]{1,64}$'),
	CONSTRAINT "collaboration_asset_crypto_version_positive" CHECK ("drawstuff_collaboration_asset"."crypto_version" >= 1),
	CONSTRAINT "collaboration_asset_byte_length_bounded" CHECK ("drawstuff_collaboration_asset"."byte_length" between 1 and 3146272)
);

CREATE TABLE "drawstuff_collaboration_control_outbox" (
	"event_id" uuid PRIMARY KEY NOT NULL,
	"room_id" varchar(64) NOT NULL,
	"auth_generation" integer NOT NULL,
	"auth_revision" integer NOT NULL,
	"action" varchar(16) NOT NULL,
	"subject_user_id" text,
	"attempts" integer NOT NULL,
	"next_attempt_at" timestamp NOT NULL,
	"status" varchar(16) NOT NULL,
	"last_failure" varchar(32),
	"delivered_at" timestamp,
	"created_at" timestamp NOT NULL,
	"updated_at" timestamp NOT NULL,
	CONSTRAINT "collaboration_control_outbox_action_supported" CHECK ("drawstuff_collaboration_control_outbox"."action" in ('revoke-member', 'end-room')),
	CONSTRAINT "collaboration_control_outbox_status_supported" CHECK ("drawstuff_collaboration_control_outbox"."status" in ('pending', 'delivered', 'failed')),
	CONSTRAINT "collaboration_control_outbox_subject_present" CHECK ("drawstuff_collaboration_control_outbox"."action" <> 'revoke-member' or "drawstuff_collaboration_control_outbox"."subject_user_id" is not null),
	CONSTRAINT "collaboration_control_outbox_last_failure_supported" CHECK ("drawstuff_collaboration_control_outbox"."last_failure" is null or "drawstuff_collaboration_control_outbox"."last_failure" in ('unreachable', 'timeout', 'rejected', 'malformed-response', 'unconfigured')),
	CONSTRAINT "collaboration_control_outbox_attempts_nonnegative" CHECK ("drawstuff_collaboration_control_outbox"."attempts" >= 0),
	CONSTRAINT "collaboration_control_outbox_auth_generation_positive" CHECK ("drawstuff_collaboration_control_outbox"."auth_generation" >= 1),
	CONSTRAINT "collaboration_control_outbox_auth_revision_positive" CHECK ("drawstuff_collaboration_control_outbox"."auth_revision" >= 1)
);

CREATE TABLE "drawstuff_collaboration_room" (
	"room_id" varchar(64) PRIMARY KEY NOT NULL,
	"scene_id" uuid NOT NULL,
	"owner_id" text NOT NULL,
	"auth_generation" integer DEFAULT 1 NOT NULL,
	"auth_revision" integer DEFAULT 1 NOT NULL,
	"link_role" varchar(16) DEFAULT 'none' NOT NULL,
	"key_check" "bytea",
	"status" varchar(16) DEFAULT 'active' NOT NULL,
	"expires_at" timestamp NOT NULL,
	"ended_at" timestamp,
	"created_at" timestamp NOT NULL,
	"updated_at" timestamp NOT NULL,
	CONSTRAINT "collaboration_room_auth_generation_positive" CHECK ("drawstuff_collaboration_room"."auth_generation" >= 1),
	CONSTRAINT "collaboration_room_auth_revision_positive" CHECK ("drawstuff_collaboration_room"."auth_revision" >= 1),
	CONSTRAINT "collaboration_room_status_supported" CHECK ("drawstuff_collaboration_room"."status" in ('active', 'ended')),
	CONSTRAINT "collaboration_room_link_role_supported" CHECK ("drawstuff_collaboration_room"."link_role" in ('none', 'viewer', 'editor')),
	CONSTRAINT "collaboration_room_key_check_length" CHECK ("drawstuff_collaboration_room"."key_check" is null or octet_length("drawstuff_collaboration_room"."key_check") = 53)
);

CREATE TABLE "drawstuff_collaboration_room_member" (
	"id" uuid PRIMARY KEY NOT NULL,
	"room_id" varchar(64) NOT NULL,
	"user_id" text NOT NULL,
	"role" varchar(16) NOT NULL,
	"revoked_at" timestamp,
	"created_at" timestamp NOT NULL,
	"updated_at" timestamp NOT NULL,
	CONSTRAINT "collaboration_room_member_role_supported" CHECK ("drawstuff_collaboration_room_member"."role" in ('owner', 'editor', 'viewer'))
);

CREATE TABLE "drawstuff_collaboration_snapshot" (
	"room_id" varchar(64) NOT NULL,
	"auth_generation" integer NOT NULL,
	"revision" integer NOT NULL,
	"crypto_version" integer NOT NULL,
	"ciphertext" "bytea" NOT NULL,
	"byte_length" integer NOT NULL,
	"checksum" varchar(64) NOT NULL,
	"updated_by" text,
	"created_at" timestamp NOT NULL,
	"updated_at" timestamp NOT NULL,
	CONSTRAINT "collaboration_snapshot_room_generation_pk" PRIMARY KEY("room_id","auth_generation"),
	CONSTRAINT "collaboration_snapshot_revision_positive" CHECK ("drawstuff_collaboration_snapshot"."revision" >= 1),
	CONSTRAINT "collaboration_snapshot_auth_generation_positive" CHECK ("drawstuff_collaboration_snapshot"."auth_generation" >= 1),
	CONSTRAINT "collaboration_snapshot_crypto_version_positive" CHECK ("drawstuff_collaboration_snapshot"."crypto_version" >= 1),
	CONSTRAINT "collaboration_snapshot_byte_length_matches" CHECK ("drawstuff_collaboration_snapshot"."byte_length" = octet_length("drawstuff_collaboration_snapshot"."ciphertext")),
	CONSTRAINT "collaboration_snapshot_byte_length_bounded" CHECK ("drawstuff_collaboration_snapshot"."byte_length" between 1 and 4194333)
);

ALTER TABLE "drawstuff_collaboration_asset" ADD CONSTRAINT "collab_asset_room_fk" FOREIGN KEY ("room_id") REFERENCES "public"."drawstuff_collaboration_room"("room_id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "drawstuff_collaboration_asset" ADD CONSTRAINT "collab_asset_registered_by_fk" FOREIGN KEY ("registered_by") REFERENCES "public"."drawstuff_user"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "drawstuff_collaboration_room" ADD CONSTRAINT "drawstuff_collaboration_room_scene_id_drawstuff_scene_id_fk" FOREIGN KEY ("scene_id") REFERENCES "public"."drawstuff_scene"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "drawstuff_collaboration_room" ADD CONSTRAINT "drawstuff_collaboration_room_owner_id_drawstuff_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."drawstuff_user"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "drawstuff_collaboration_room_member" ADD CONSTRAINT "collab_member_room_fk" FOREIGN KEY ("room_id") REFERENCES "public"."drawstuff_collaboration_room"("room_id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "drawstuff_collaboration_room_member" ADD CONSTRAINT "collab_member_user_fk" FOREIGN KEY ("user_id") REFERENCES "public"."drawstuff_user"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "drawstuff_collaboration_snapshot" ADD CONSTRAINT "collab_snapshot_room_fk" FOREIGN KEY ("room_id") REFERENCES "public"."drawstuff_collaboration_room"("room_id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "drawstuff_collaboration_snapshot" ADD CONSTRAINT "collab_snapshot_updated_by_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."drawstuff_user"("id") ON DELETE set null ON UPDATE no action;
CREATE INDEX "collaboration_control_outbox_due_idx" ON "drawstuff_collaboration_control_outbox" USING btree ("status","next_attempt_at");
CREATE INDEX "collaboration_room_owner_id_idx" ON "drawstuff_collaboration_room" USING btree ("owner_id");
CREATE INDEX "collaboration_room_status_expires_at_idx" ON "drawstuff_collaboration_room" USING btree ("status","expires_at");
CREATE UNIQUE INDEX "collaboration_room_active_scene_unique" ON "drawstuff_collaboration_room" USING btree ("scene_id") WHERE status = 'active';
CREATE UNIQUE INDEX "collaboration_room_member_room_user_unique" ON "drawstuff_collaboration_room_member" USING btree ("room_id","user_id");
CREATE INDEX "collaboration_room_member_user_id_idx" ON "drawstuff_collaboration_room_member" USING btree ("user_id");
COMMIT;
