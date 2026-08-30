import { relations } from "drizzle-orm/relations";
import { sources, baselineEstimates, people, pledgeHoldings, assets, ownershipLinks, equityHoldings, eventAssetLinks, events, eventImpacts } from "./schema";

export const baselineEstimatesRelations = relations(baselineEstimates, ({one}) => ({
	source: one(sources, {
		fields: [baselineEstimates.sourceId],
		references: [sources.id]
	}),
	person: one(people, {
		fields: [baselineEstimates.personId],
		references: [people.id]
	}),
}));

export const sourcesRelations = relations(sources, ({many}) => ({
	baselineEstimates: many(baselineEstimates),
	assets: many(assets),
	ownershipLinks: many(ownershipLinks),
	events: many(events),
}));

export const peopleRelations = relations(people, ({many}) => ({
	baselineEstimates: many(baselineEstimates),
	pledgeHoldings: many(pledgeHoldings),
	ownershipLinks: many(ownershipLinks),
	equityHoldings: many(equityHoldings),
}));

export const pledgeHoldingsRelations = relations(pledgeHoldings, ({one}) => ({
	person: one(people, {
		fields: [pledgeHoldings.personId],
		references: [people.id]
	}),
}));

export const assetsRelations = relations(assets, ({one, many}) => ({
	source: one(sources, {
		fields: [assets.sourceId],
		references: [sources.id]
	}),
	ownershipLinks: many(ownershipLinks),
	eventAssetLinks: many(eventAssetLinks),
}));

export const ownershipLinksRelations = relations(ownershipLinks, ({one}) => ({
	source: one(sources, {
		fields: [ownershipLinks.sourceId],
		references: [sources.id]
	}),
	person: one(people, {
		fields: [ownershipLinks.personId],
		references: [people.id]
	}),
	asset: one(assets, {
		fields: [ownershipLinks.assetId],
		references: [assets.id]
	}),
}));

export const equityHoldingsRelations = relations(equityHoldings, ({one}) => ({
	person: one(people, {
		fields: [equityHoldings.personId],
		references: [people.id]
	}),
}));

export const eventAssetLinksRelations = relations(eventAssetLinks, ({one, many}) => ({
	asset: one(assets, {
		fields: [eventAssetLinks.assetId],
		references: [assets.id]
	}),
	event: one(events, {
		fields: [eventAssetLinks.eventId],
		references: [events.id]
	}),
	eventImpacts: many(eventImpacts),
}));

export const eventsRelations = relations(events, ({many}) => ({
	eventAssetLinks: many(eventAssetLinks),
}));

export const eventImpactsRelations = relations(eventImpacts, ({one}) => ({
	eventAssetLink: one(eventAssetLinks, {
		fields: [eventImpacts.eventAssetLinkId],
		references: [eventAssetLinks.id]
	}),
}));