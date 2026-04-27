CREATE TABLE "handle_claims" (
	"handle" text PRIMARY KEY NOT NULL,
	"owner_kind" text NOT NULL,
	"owner_id" text NOT NULL,
	"season_id" integer NOT NULL,
	"claimed_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE INDEX "handle_claims_owner_idx" ON "handle_claims" USING btree ("owner_kind","owner_id");--> statement-breakpoint
CREATE INDEX "handle_claims_season_idx" ON "handle_claims" USING btree ("season_id");