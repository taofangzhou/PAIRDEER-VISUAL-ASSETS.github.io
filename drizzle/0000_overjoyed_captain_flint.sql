CREATE TABLE `admin` (
	`id` integer PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `catalog` (
	`id` integer PRIMARY KEY NOT NULL,
	`data` text NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `favorites` (
	`user_id` text PRIMARY KEY NOT NULL,
	`data` text NOT NULL
);
