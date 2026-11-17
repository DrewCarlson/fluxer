// SPDX-License-Identifier: AGPL-3.0-or-later

// Fluxcord patch: history that is older than its channel stays listed.

import {type ChannelID, createChannelID, createMessageID, createUserID, type MessageID} from '@app/api/BrandedTypes';
import {MessageDataRepository} from '@app/api/channel/repositories/message/MessageDataRepository';
import {fetchOne, setCassandraQueryExecutorForTesting} from '@app/api/database/CassandraQueryExecution';
import type {ChannelStateRow, MessageRow} from '@app/api/database/types/MessageTypes';
import {ChannelState} from '@app/api/Tables';
import {InMemoryCassandraQueryExecutor} from '@app/api/test/InMemoryCassandraQueryExecutor';
import * as BucketUtils from '@fluxer/snowflake/src/SnowflakeBuckets';
import {beforeEach, describe, expect, it} from 'vitest';

const FETCH_CHANNEL_STATE = ChannelState.select({where: ChannelState.where.eq('channel_id'), limit: 1});

function row(channelId: ChannelID, messageId: MessageID): MessageRow {
	return {
		channel_id: channelId,
		bucket: BucketUtils.makeBucket(messageId),
		message_id: messageId,
		author_id: createUserID(7n),
		type: 0,
		webhook_id: null,
		webhook_name: null,
		webhook_avatar_hash: null,
		content: 'hello',
		edited_timestamp: null,
		pinned_timestamp: null,
		flags: 0,
		mention_everyone: false,
		mention_users: null,
		mention_roles: null,
		mention_channels: null,
		attachments: null,
		embeds: null,
		sticker_items: null,
		message_reference: null,
		message_snapshots: null,
		call: null,
		has_reaction: false,
		version: 1,
	};
}

async function createdBucket(channelId: ChannelID): Promise<number | undefined> {
	return (await fetchOne<ChannelStateRow>(FETCH_CHANNEL_STATE.bind({channel_id: channelId})))?.created_bucket;
}

describe('Fluxcord message import', () => {
	beforeEach(() => {
		setCassandraQueryExecutorForTesting(new InMemoryCassandraQueryExecutor());
	});

	it('lists a message that is older than its channel, also after newer messages', async () => {
		const channelId = createChannelID(1400000000000000000n);
		const newer = createMessageID(1450000000000000000n);
		const imported = createMessageID(1200000000000000000n);
		const later = createMessageID(1500000000000000000n);
		const repository = new MessageDataRepository();
		await repository.upsertMessage(row(channelId, newer), null);

		await repository.upsertMessage(row(channelId, imported), null);
		await repository.lowerCreatedBucket(channelId, BucketUtils.makeBucket(imported));
		await repository.upsertMessage(row(channelId, later), null);

		expect(await createdBucket(channelId)).toBe(BucketUtils.makeBucket(imported));
		const listed = await repository.listMessages(channelId, undefined, 10);
		expect(listed.map((message) => message.id)).toEqual([later, newer, imported]);
		const before = await repository.listMessages(channelId, newer, 10);
		expect(before.map((message) => message.id)).toEqual([imported]);
	});

	it('never raises the first bucket', async () => {
		const channelId = createChannelID(1400000000000000000n);
		const repository = new MessageDataRepository();
		await repository.upsertMessage(row(channelId, createMessageID(1450000000000000000n)), null);
		const original = await createdBucket(channelId);

		await repository.lowerCreatedBucket(channelId, BucketUtils.makeBucket(createMessageID(1460000000000000000n)));

		expect(await createdBucket(channelId)).toBe(original);
	});
});
