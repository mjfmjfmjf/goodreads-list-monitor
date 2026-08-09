import { runGroupedCommand, publisherExtractor, GroupedCommandOptions } from './favoriteAuthors.js';

export type PublisherStatsOptions = GroupedCommandOptions;

export async function runPublisherStats(options: PublisherStatsOptions = {}): Promise<void> {
  await runGroupedCommand(options, {
    command: 'Favorite Publishers',
    nounPlural: 'publishers',
    nounSingular: 'publisher',
    nounCap: 'Publishers',
    skipLabel: 'no publisher',
    definition: '   Definition: read shelf + rated books from the library export (myRating 1-5), grouped by publisher',
    extract: publisherExtractor
  });
}
