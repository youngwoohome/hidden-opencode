CREATE TABLE `github_token` (
	`id` varchar(30) NOT NULL,
	`time_created` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`time_updated` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
	`time_deleted` timestamp(3),
	`account_id` varchar(30) NOT NULL,
	`access_token` text NOT NULL,
	`scope` text,
	`token_type` varchar(32),
	PRIMARY KEY (`id`),
	UNIQUE KEY `account_id` (`account_id`)
);

CREATE TABLE `github_repo_allowlist` (
	`id` varchar(30) NOT NULL,
	`workspace_id` varchar(30) NOT NULL,
	`time_created` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`time_updated` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
	`time_deleted` timestamp(3),
	`owner` varchar(255) NOT NULL,
	`repo` varchar(255) NOT NULL,
	`added_by_account_id` varchar(30),
	PRIMARY KEY (`workspace_id`,`id`),
	UNIQUE KEY `workspace_repo` (`workspace_id`,`owner`,`repo`)
);
