CREATE TYPE "public"."actor" AS ENUM('automation', 'human');--> statement-breakpoint
CREATE TYPE "public"."approval" AS ENUM('draft', 'approved');--> statement-breakpoint
CREATE TYPE "public"."evidence_kind" AS ENUM('screenshot', 'trace', 'journal', 'artifact');--> statement-breakpoint
CREATE TYPE "public"."intervention_state" AS ENUM('open', 'claimed', 'resolved', 'aborted');--> statement-breakpoint
CREATE TYPE "public"."run_control" AS ENUM('automation', 'paused', 'human', 'resuming');--> statement-breakpoint
CREATE TYPE "public"."run_mode" AS ENUM('discovery', 'replay');--> statement-breakpoint
CREATE TYPE "public"."run_state" AS ENUM('queued', 'running', 'paused', 'done', 'failed');--> statement-breakpoint
CREATE TYPE "public"."step_outcome" AS ENUM('ok', 'business_outcome', 'recoverable', 'stuck', 'failed');--> statement-breakpoint
CREATE TABLE "capabilities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ref" text NOT NULL,
	"version" integer NOT NULL,
	"body" jsonb NOT NULL,
	"approval" "approval" DEFAULT 'draft' NOT NULL,
	"app_id" text NOT NULL,
	"variant" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "capabilities_ref_version_unique" UNIQUE("ref","version")
);
--> statement-breakpoint
CREATE TABLE "evidence" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" text NOT NULL,
	"kind" "evidence_kind" NOT NULL,
	"path" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "interventions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" text NOT NULL,
	"step_index" integer NOT NULL,
	"reason" text NOT NULL,
	"expected" text,
	"observed" text,
	"screenshot_path" text,
	"state" "intervention_state" DEFAULT 'open' NOT NULL,
	"operator_note" text,
	"raised_at" timestamp with time zone DEFAULT now() NOT NULL,
	"claimed_at" timestamp with time zone,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "runs" (
	"id" text PRIMARY KEY NOT NULL,
	"mode" "run_mode" NOT NULL,
	"capability_ref" text,
	"goal" text,
	"inputs" jsonb,
	"state" "run_state" DEFAULT 'queued' NOT NULL,
	"control" "run_control" DEFAULT 'automation' NOT NULL,
	"result" jsonb,
	"worker_addr" text,
	"claimed_at" timestamp with time zone,
	"heartbeat_at" timestamp with time zone,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "steps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" text NOT NULL,
	"index" integer NOT NULL,
	"step_id" text NOT NULL,
	"action" text NOT NULL,
	"resolution_tier" integer,
	"outcome" "step_outcome" NOT NULL,
	"detail" text,
	"latency_ms" integer,
	"actor" "actor" DEFAULT 'automation' NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interventions" ADD CONSTRAINT "interventions_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "steps" ADD CONSTRAINT "steps_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "capabilities_ref_idx" ON "capabilities" USING btree ("ref");--> statement-breakpoint
CREATE INDEX "evidence_run_idx" ON "evidence" USING btree ("run_id","at");--> statement-breakpoint
CREATE INDEX "interventions_state_idx" ON "interventions" USING btree ("state","raised_at");--> statement-breakpoint
CREATE INDEX "runs_state_started_idx" ON "runs" USING btree ("state","started_at");--> statement-breakpoint
CREATE INDEX "runs_heartbeat_idx" ON "runs" USING btree ("heartbeat_at");--> statement-breakpoint
CREATE INDEX "steps_run_index_idx" ON "steps" USING btree ("run_id","index");