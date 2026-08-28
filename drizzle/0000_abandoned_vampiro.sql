CREATE TABLE `billionaires` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`rank` integer NOT NULL,
	`prev_rank` integer,
	`source` text NOT NULL,
	`industry` text NOT NULL,
	`country` text NOT NULL,
	`estimated_wealth` real NOT NULL,
	`confirmed_wealth` real NOT NULL,
	`liquidity_pct` real NOT NULL,
	`last_updated` text NOT NULL
);
