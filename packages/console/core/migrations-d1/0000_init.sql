CREATE TABLE `account` (
	`id` text(30) PRIMARY KEY NOT NULL,
	`time_created` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`time_updated` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`time_deleted` integer
);
--> statement-breakpoint
CREATE TABLE `auth` (
	`id` text(30) PRIMARY KEY NOT NULL,
	`time_created` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`time_updated` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`time_deleted` integer,
	`provider` text NOT NULL,
	`subject` text(255) NOT NULL,
	`account_id` text(30) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `auth_provider_subject` ON `auth` (`provider`,`subject`);--> statement-breakpoint
CREATE INDEX `account_id` ON `auth` (`account_id`);--> statement-breakpoint
CREATE TABLE `benchmark` (
	`id` text(30) PRIMARY KEY NOT NULL,
	`time_created` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`time_updated` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`time_deleted` integer,
	`model` text(64) NOT NULL,
	`agent` text(64) NOT NULL,
	`result` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `time_created` ON `benchmark` (`time_created`);--> statement-breakpoint
CREATE TABLE `billing` (
	`id` text(30) NOT NULL,
	`workspace_id` text(30) NOT NULL,
	`time_created` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`time_updated` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`time_deleted` integer,
	`customer_id` text(255),
	`payment_method_id` text(255),
	`payment_method_type` text(32),
	`payment_method_last4` text(4),
	`balance` integer NOT NULL,
	`monthly_limit` integer,
	`monthly_usage` integer,
	`time_monthly_usage_updated` integer,
	`reload` integer,
	`reload_trigger` integer,
	`reload_amount` integer,
	`reload_error` text(255),
	`time_reload_error` integer,
	`time_reload_locked_till` integer,
	`subscription_id` text(28),
	`subscription_coupon_id` text(28),
	PRIMARY KEY(`workspace_id`, `id`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `global_customer_id` ON `billing` (`customer_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `global_subscription_id` ON `billing` (`subscription_id`);--> statement-breakpoint
CREATE TABLE `payment` (
	`id` text(30) NOT NULL,
	`workspace_id` text(30) NOT NULL,
	`time_created` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`time_updated` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`time_deleted` integer,
	`customer_id` text(255),
	`invoice_id` text(255),
	`payment_id` text(255),
	`amount` integer NOT NULL,
	`time_refunded` integer,
	`enrichment` text,
	PRIMARY KEY(`workspace_id`, `id`)
);
--> statement-breakpoint
CREATE TABLE `subscription` (
	`id` text(30) NOT NULL,
	`workspace_id` text(30) NOT NULL,
	`time_created` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`time_updated` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`time_deleted` integer,
	`user_id` text(30) NOT NULL,
	`rolling_usage` integer,
	`fixed_usage` integer,
	`time_rolling_updated` integer,
	`time_fixed_updated` integer,
	PRIMARY KEY(`workspace_id`, `id`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workspace_user_id` ON `subscription` (`workspace_id`,`user_id`);--> statement-breakpoint
CREATE TABLE `usage` (
	`id` text(30) NOT NULL,
	`workspace_id` text(30) NOT NULL,
	`time_created` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`time_updated` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`time_deleted` integer,
	`model` text(255) NOT NULL,
	`provider` text(255) NOT NULL,
	`input_tokens` integer NOT NULL,
	`output_tokens` integer NOT NULL,
	`reasoning_tokens` integer,
	`cache_read_tokens` integer,
	`cache_write_5m_tokens` integer,
	`cache_write_1h_tokens` integer,
	`cost` integer NOT NULL,
	`key_id` text(30),
	`enrichment` text,
	PRIMARY KEY(`workspace_id`, `id`)
);
--> statement-breakpoint
CREATE INDEX `usage_time_created` ON `usage` (`workspace_id`,`time_created`);--> statement-breakpoint
CREATE TABLE `github_repo_allowlist` (
	`id` text(30) NOT NULL,
	`workspace_id` text(30) NOT NULL,
	`time_created` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`time_updated` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`time_deleted` integer,
	`owner` text(255) NOT NULL,
	`repo` text(255) NOT NULL,
	`added_by_account_id` text(30),
	PRIMARY KEY(`workspace_id`, `id`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workspace_repo` ON `github_repo_allowlist` (`workspace_id`,`owner`,`repo`);--> statement-breakpoint
CREATE TABLE `github_token` (
	`id` text(30) PRIMARY KEY NOT NULL,
	`time_created` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`time_updated` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`time_deleted` integer,
	`account_id` text(30) NOT NULL,
	`access_token` text NOT NULL,
	`scope` text,
	`token_type` text(32)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `github_token_account_id` ON `github_token` (`account_id`);--> statement-breakpoint
CREATE TABLE `ip_rate_limit` (
	`ip` text(45) NOT NULL,
	`interval` text(10) NOT NULL,
	`count` integer NOT NULL,
	PRIMARY KEY(`ip`, `interval`)
);
--> statement-breakpoint
CREATE TABLE `ip` (
	`ip` text(45) PRIMARY KEY NOT NULL,
	`time_created` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`time_updated` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`time_deleted` integer,
	`usage` integer
);
--> statement-breakpoint
CREATE TABLE `key` (
	`id` text(30) NOT NULL,
	`workspace_id` text(30) NOT NULL,
	`time_created` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`time_updated` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`time_deleted` integer,
	`name` text(255) NOT NULL,
	`key` text(255) NOT NULL,
	`user_id` text(30) NOT NULL,
	`time_used` integer,
	PRIMARY KEY(`workspace_id`, `id`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `global_key` ON `key` (`key`);--> statement-breakpoint
CREATE TABLE `model` (
	`id` text(30) NOT NULL,
	`workspace_id` text(30) NOT NULL,
	`time_created` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`time_updated` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`time_deleted` integer,
	`model` text(64) NOT NULL,
	PRIMARY KEY(`workspace_id`, `id`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `model_workspace_model` ON `model` (`workspace_id`,`model`);--> statement-breakpoint
CREATE TABLE `provider` (
	`id` text(30) NOT NULL,
	`workspace_id` text(30) NOT NULL,
	`time_created` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`time_updated` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`time_deleted` integer,
	`provider` text(64) NOT NULL,
	`credentials` text NOT NULL,
	PRIMARY KEY(`workspace_id`, `id`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workspace_provider` ON `provider` (`workspace_id`,`provider`);--> statement-breakpoint
CREATE TABLE `user` (
	`id` text(30) NOT NULL,
	`workspace_id` text(30) NOT NULL,
	`time_created` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`time_updated` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`time_deleted` integer,
	`account_id` text(30),
	`email` text(255),
	`name` text(255) NOT NULL,
	`time_seen` integer,
	`color` integer,
	`role` text NOT NULL,
	`monthly_limit` integer,
	`monthly_usage` integer,
	`time_monthly_usage_updated` integer,
	PRIMARY KEY(`workspace_id`, `id`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_account_id` ON `user` (`workspace_id`,`account_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `user_email` ON `user` (`workspace_id`,`email`);--> statement-breakpoint
CREATE INDEX `global_account_id` ON `user` (`account_id`);--> statement-breakpoint
CREATE INDEX `global_email` ON `user` (`email`);--> statement-breakpoint
CREATE TABLE `workspace` (
	`id` text(30) PRIMARY KEY NOT NULL,
	`slug` text(255),
	`name` text(255) NOT NULL,
	`time_created` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`time_updated` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`time_deleted` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `slug` ON `workspace` (`slug`);