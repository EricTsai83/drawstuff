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

CREATE TABLE "drawstuff_collaboration_creation_fence" (
	"room_id" varchar(64) PRIMARY KEY NOT NULL,
	"ended" boolean DEFAULT false NOT NULL
);

CREATE TABLE "drawstuff_collaboration_lifecycle_registration" (
	"subject" text NOT NULL,
	"room_id" varchar(64) NOT NULL,
	"scene_id" uuid,
	"owner" boolean NOT NULL,
	"lifecycle_version" integer NOT NULL,
	"operation_id" uuid NOT NULL,
	CONSTRAINT "drawstuff_collaboration_lifecycle_registration_subject_room_id_pk" PRIMARY KEY("subject","room_id"),
	CONSTRAINT "collaboration_lifecycle_registration_version" CHECK ("drawstuff_collaboration_lifecycle_registration"."lifecycle_version">0)
);

CREATE TABLE "drawstuff_collaboration_lifecycle_subject" (
	"scope" varchar(160) PRIMARY KEY NOT NULL,
	"kind" varchar(16) NOT NULL,
	"subject" text NOT NULL,
	"scene_id" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"frozen" boolean DEFAULT false NOT NULL,
	"retired" boolean DEFAULT false NOT NULL,
	"operation_id" uuid,
	CONSTRAINT "collaboration_lifecycle_subject_shape" CHECK (("drawstuff_collaboration_lifecycle_subject"."kind"='account' and "drawstuff_collaboration_lifecycle_subject"."scene_id" is null and "drawstuff_collaboration_lifecycle_subject"."scope"='account:' || "drawstuff_collaboration_lifecycle_subject"."subject") or ("drawstuff_collaboration_lifecycle_subject"."kind"='scene' and "drawstuff_collaboration_lifecycle_subject"."scene_id" is not null and "drawstuff_collaboration_lifecycle_subject"."scope"='scene:' || "drawstuff_collaboration_lifecycle_subject"."scene_id"::text)),
	CONSTRAINT "collaboration_lifecycle_subject_version" CHECK ("drawstuff_collaboration_lifecycle_subject"."version">0),
	CONSTRAINT "collaboration_lifecycle_subject_retired_frozen" CHECK (not "drawstuff_collaboration_lifecycle_subject"."retired" or "drawstuff_collaboration_lifecycle_subject"."frozen")
);

CREATE TABLE "drawstuff_collaboration_operation" (
	"operation_id" uuid PRIMARY KEY NOT NULL,
	"room_id" varchar(64) NOT NULL,
	"actor" text NOT NULL,
	"kind" varchar(32) NOT NULL,
	"authority_epoch" integer NOT NULL,
	"auth_generation" integer NOT NULL,
	"expected_revision" integer NOT NULL,
	"checksum" varchar(64) NOT NULL,
	"request_fingerprint" varchar(64) NOT NULL,
	"asset_id" varchar(64),
	"ut_file_key" varchar(256),
	"deadline" timestamp NOT NULL,
	"status" varchar(16) NOT NULL,
	"revision" integer,
	"terminal_at" timestamp,
	CONSTRAINT "collaboration_operation_kind" CHECK ("drawstuff_collaboration_operation"."kind" in ('snapshot-put','snapshot-reset','asset-finalize')),
	CONSTRAINT "collaboration_operation_status" CHECK ("drawstuff_collaboration_operation"."status" in ('pending','written','cancelled','refused','conflict')),
	CONSTRAINT "collaboration_operation_versions" CHECK ("drawstuff_collaboration_operation"."authority_epoch">0 and "drawstuff_collaboration_operation"."auth_generation">0 and "drawstuff_collaboration_operation"."expected_revision">=0),
	CONSTRAINT "collaboration_operation_checksum" CHECK ("drawstuff_collaboration_operation"."checksum" ~ '^[a-f0-9]{64}$' and "drawstuff_collaboration_operation"."request_fingerprint" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "collaboration_operation_asset_identity" CHECK (("drawstuff_collaboration_operation"."kind"='asset-finalize') = ("drawstuff_collaboration_operation"."asset_id" is not null) and ("drawstuff_collaboration_operation"."asset_id" is null) = ("drawstuff_collaboration_operation"."ut_file_key" is null)),
	CONSTRAINT "collaboration_operation_result" CHECK (("drawstuff_collaboration_operation"."status"='written') = ("drawstuff_collaboration_operation"."revision" is not null) and ("drawstuff_collaboration_operation"."revision" is null or "drawstuff_collaboration_operation"."revision">0) and ("drawstuff_collaboration_operation"."status"='pending') = ("drawstuff_collaboration_operation"."terminal_at" is null))
);

CREATE TABLE "drawstuff_collaboration_projection_tombstone" (
	"room_id" varchar(64) NOT NULL,
	"subject" text NOT NULL,
	"version" integer NOT NULL,
	CONSTRAINT "drawstuff_collaboration_projection_tombstone_room_id_subject_pk" PRIMARY KEY("room_id","subject"),
	CONSTRAINT "collaboration_projection_tombstone_version" CHECK ("drawstuff_collaboration_projection_tombstone"."version">0)
);

CREATE TABLE "drawstuff_collaboration_room" (
	"room_id" varchar(64) PRIMARY KEY NOT NULL,
	"scene_id" uuid,
	"owner_id" text NOT NULL,
	"auth_generation" integer DEFAULT 1 NOT NULL,
	"auth_revision" integer DEFAULT 1 NOT NULL,
	"link_role" varchar(16) DEFAULT 'none' NOT NULL,
	"key_check" "bytea",
	"status" varchar(16) DEFAULT 'initializing' NOT NULL,
	"authority_epoch" integer DEFAULT 1 NOT NULL,
	"storage_generation" integer DEFAULT 1 NOT NULL,
	"storage_state" varchar(16) DEFAULT 'initializing' NOT NULL,
	"snapshot_revision" integer DEFAULT 0 NOT NULL,
	"projection_version" integer DEFAULT 1 NOT NULL,
	"label" varchar(120) DEFAULT '' NOT NULL,
	"create_operation_id" uuid NOT NULL,
	"initialization_deadline" timestamp DEFAULT now() + interval '15 minutes' NOT NULL,
	"initialization_asset_ids" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"initialization_revision" integer,
	"initialization_checksum" varchar(64),
	"ended_at" timestamp,
	"created_at" timestamp NOT NULL,
	"updated_at" timestamp NOT NULL,
	CONSTRAINT "drawstuff_collaboration_room_create_operation_id_unique" UNIQUE("create_operation_id"),
	CONSTRAINT "collaboration_room_authority_epoch_positive" CHECK ("drawstuff_collaboration_room"."authority_epoch" >= 1),
	CONSTRAINT "collaboration_room_storage_fence" CHECK ("drawstuff_collaboration_room"."storage_generation">0 and "drawstuff_collaboration_room"."snapshot_revision">=0 and "drawstuff_collaboration_room"."storage_state" in ('initializing','ready','ended')),
	CONSTRAINT "collaboration_room_projection_version_positive" CHECK ("drawstuff_collaboration_room"."projection_version" >= 1),
	CONSTRAINT "collaboration_room_initialization_assets_bounded" CHECK (cardinality("drawstuff_collaboration_room"."initialization_asset_ids") <= 512),
	CONSTRAINT "collaboration_room_initialization_checksum" CHECK ("drawstuff_collaboration_room"."initialization_checksum" is null or "drawstuff_collaboration_room"."initialization_checksum" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "collaboration_room_initialization_manifest" CHECK (("drawstuff_collaboration_room"."initialization_revision" is null) = ("drawstuff_collaboration_room"."initialization_checksum" is null) and ("drawstuff_collaboration_room"."initialization_revision" is null or "drawstuff_collaboration_room"."initialization_revision" > 0)),
	CONSTRAINT "collaboration_room_auth_generation_positive" CHECK ("drawstuff_collaboration_room"."auth_generation" >= 1),
	CONSTRAINT "collaboration_room_auth_revision_positive" CHECK ("drawstuff_collaboration_room"."auth_revision" >= 1),
	CONSTRAINT "collaboration_room_status_supported_v6" CHECK ("drawstuff_collaboration_room"."status" in ('initializing', 'ready', 'ended')),
	CONSTRAINT "collaboration_room_link_role_supported" CHECK ("drawstuff_collaboration_room"."link_role" in ('none', 'viewer', 'editor')),
	CONSTRAINT "collaboration_room_key_check_length" CHECK ("drawstuff_collaboration_room"."key_check" is null or octet_length("drawstuff_collaboration_room"."key_check") = 53)
);

CREATE TABLE "drawstuff_collaboration_room_member" (
	"id" uuid PRIMARY KEY NOT NULL,
	"room_id" varchar(64) NOT NULL,
	"user_id" text NOT NULL,
	"role" varchar(16) NOT NULL,
	"revoked_at" timestamp,
	"projection_version" integer DEFAULT 1 NOT NULL,
	"listed_at" timestamp DEFAULT now() NOT NULL,
	"created_at" timestamp NOT NULL,
	"updated_at" timestamp NOT NULL,
	CONSTRAINT "collaboration_room_member_projection_version_positive" CHECK ("drawstuff_collaboration_room_member"."projection_version" >= 1),
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
ALTER TABLE "drawstuff_collaboration_operation" ADD CONSTRAINT "drawstuff_collaboration_operation_room_id_drawstuff_collaboration_room_room_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."drawstuff_collaboration_room"("room_id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "drawstuff_collaboration_room" ADD CONSTRAINT "drawstuff_collaboration_room_scene_id_drawstuff_scene_id_fk" FOREIGN KEY ("scene_id") REFERENCES "public"."drawstuff_scene"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "drawstuff_collaboration_room" ADD CONSTRAINT "drawstuff_collaboration_room_owner_id_drawstuff_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."drawstuff_user"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "drawstuff_collaboration_room_member" ADD CONSTRAINT "collab_member_room_fk" FOREIGN KEY ("room_id") REFERENCES "public"."drawstuff_collaboration_room"("room_id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "drawstuff_collaboration_room_member" ADD CONSTRAINT "collab_member_user_fk" FOREIGN KEY ("user_id") REFERENCES "public"."drawstuff_user"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "drawstuff_collaboration_snapshot" ADD CONSTRAINT "collab_snapshot_room_fk" FOREIGN KEY ("room_id") REFERENCES "public"."drawstuff_collaboration_room"("room_id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "drawstuff_collaboration_snapshot" ADD CONSTRAINT "collab_snapshot_updated_by_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."drawstuff_user"("id") ON DELETE set null ON UPDATE no action;
CREATE INDEX "collaboration_lifecycle_registration_scene_idx" ON "drawstuff_collaboration_lifecycle_registration" USING btree ("scene_id","room_id");
CREATE INDEX "collaboration_operation_terminal_idx" ON "drawstuff_collaboration_operation" USING btree ("terminal_at");
CREATE INDEX "collaboration_room_owner_id_idx" ON "drawstuff_collaboration_room" USING btree ("owner_id");
CREATE INDEX "collaboration_room_status_ended_at_idx" ON "drawstuff_collaboration_room" USING btree ("status","ended_at");
CREATE UNIQUE INDEX "collaboration_room_active_scene_unique_v6" ON "drawstuff_collaboration_room" USING btree ("scene_id") WHERE status in ('initializing', 'ready');
CREATE UNIQUE INDEX "collaboration_room_member_room_user_unique" ON "drawstuff_collaboration_room_member" USING btree ("room_id","user_id");
CREATE INDEX "collaboration_room_member_user_listed_idx" ON "drawstuff_collaboration_room_member" USING btree ("user_id","listed_at" DESC NULLS LAST,"room_id" DESC NULLS LAST);
COMMIT;
