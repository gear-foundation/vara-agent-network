ALTER TABLE "app_metrics" RENAME COLUMN "time_to_first_integration_blocks" TO "first_integration_block";--> statement-breakpoint
ALTER TABLE "app_metrics" ALTER COLUMN "call_graph_density" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "app_metrics" ALTER COLUMN "call_graph_density" DROP NOT NULL;