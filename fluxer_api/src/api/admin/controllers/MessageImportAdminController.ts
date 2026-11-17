// SPDX-License-Identifier: AGPL-3.0-or-later

// Fluxcord patch: imports messages with their original ids and times, for a bridge that copies
// older history from another service. https://github.com/DrewCarlson/Fluxcord

import {createChannelID, createMessageID, createUserID, type UserID} from '@app/api/BrandedTypes';
import type {AttachmentToProcess} from '@app/api/channel/AttachmentDTOs';
import type {MessageReference} from '@app/api/database/types/MessageTypes';
import {requireAdminACL} from '@app/api/middleware/AdminMiddleware';
import {RateLimitMiddleware} from '@app/api/middleware/RateLimitMiddleware';
import {OpenAPI} from '@app/api/middleware/ResponseTypeMiddleware';
import {AdminRateLimitConfigs} from '@app/api/rate_limit_configs/AdminRateLimitConfig';
import type {HonoApp} from '@app/api/types/HonoEnv';
import {Validator} from '@app/api/Validator';
import {MessageTypes} from '@fluxer/constants/src/ChannelConstants';
import {UnknownChannelError} from '@fluxer/errors/src/domains/channel/UnknownChannelError';
import {MissingAccessError} from '@fluxer/errors/src/domains/core/MissingAccessError';
import {UnknownUserError} from '@fluxer/errors/src/domains/user/UnknownUserError';
import {ChannelIdParam} from '@fluxer/schema/src/domains/common/CommonParamSchemas';
import {SnowflakeType} from '@fluxer/schema/src/primitives/SchemaPrimitives';
import * as BucketUtils from '@fluxer/snowflake/src/SnowflakeBuckets';
import {extractTimestampBigInt} from '@fluxer/snowflake/src/SnowflakeUtils';
import {z} from 'zod';

/** Admin API keys with this ACL (or `*`) may import messages. */
export const MESSAGE_IMPORT_ACL = 'message:import';

const MAX_CONTENT_LENGTH = 4000;
const MAX_ATTACHMENTS = 10;
const USER_MENTION = /<@!?(\d+)>/g;

const ImportedAttachment = z.object({
	id: z.number().int().min(0),
	filename: z.string().min(1).max(255),
	upload_filename: z.string().min(1),
	file_size: z.number().int().min(0),
	content_type: z.string().min(1).max(255),
	title: z.string().max(1024).nullish(),
	description: z.string().max(4096).nullish(),
	flags: z.number().int().min(0).default(0),
	duration: z.number().int().min(0).nullish(),
	waveform: z.string().max(4096).nullish(),
});

const ImportMessageRequest = z.object({
	message_id: SnowflakeType.describe(
		'The id of the new message. Its time is the time of the message; Discord ids keep their time.',
	),
	author_id: SnowflakeType.describe('The author; a recipient of the channel when it is a DM'),
	content: z.string().max(MAX_CONTENT_LENGTH).nullish(),
	flags: z.number().int().min(0).default(0),
	reply_to: SnowflakeType.nullish().describe('A message in the same channel that this one replies to'),
	edited_timestamp: z.string().datetime().nullish(),
	attachments: z
		.array(ImportedAttachment)
		.max(MAX_ATTACHMENTS)
		.default([])
		.describe('Files that the author uploaded with the presigned attachment upload flow'),
});

const ImportMessageResponse = z.object({
	id: SnowflakeType,
	created: z.boolean().describe('False when a message with this id was in the channel already'),
});

export function MessageImportAdminController(app: HonoApp) {
	app.post(
		'/admin/channels/:channel_id/messages/import',
		RateLimitMiddleware(AdminRateLimitConfigs.ADMIN_MESSAGE_OPERATION),
		requireAdminACL(MESSAGE_IMPORT_ACL),
		Validator('param', ChannelIdParam),
		Validator('json', ImportMessageRequest),
		OpenAPI({
			operationId: 'import_admin_channel_message',
			summary: 'Import a message with its original time',
			responseSchema: ImportMessageResponse,
			statusCode: 200,
			security: 'adminApiKey',
			tags: 'Admin',
			description:
				'Fluxcord patch. Stores a message with a given id, so it takes its place in the history by its time. ' +
				'It sends no gateway event, no notification and no push, and it does not change read states. ' +
				'A message with the same id is not stored again. Requires the message:import ACL.',
		}),
		async (ctx) => {
			const channelId = createChannelID(ctx.req.valid('param').channel_id);
			const body = ctx.req.valid('json');
			const messageId = createMessageID(body.message_id);
			const authorId = createUserID(body.author_id);
			const channelRepository = ctx.get('channelRepository');

			const channel = await channelRepository.channelData.findUnique(channelId);
			if (!channel) throw new UnknownChannelError();
			const author = await ctx.get('userRepository').findUnique(authorId);
			if (!author) throw new UnknownUserError();
			if (!channel.guildId && !channel.recipientIds.has(authorId)) throw new MissingAccessError();
			if (extractTimestampBigInt(messageId) > Date.now()) throw new MissingAccessError();

			const existing = await channelRepository.messages.getMessage(channelId, messageId);
			if (existing) return ctx.json({id: existing.id.toString(), created: false});

			const messageReference: MessageReference | undefined = body.reply_to
				? {channel_id: channelId, message_id: createMessageID(body.reply_to), guild_id: channel.guildId, type: 0}
				: undefined;
			const attachments: Array<AttachmentToProcess> = body.attachments.map((attachment) => ({
				...attachment,
				title: attachment.title ?? null,
				description: attachment.description ?? null,
			}));
			const mentionUserIds: Array<UserID> = [...(body.content ?? '').matchAll(USER_MENTION)].map((match) =>
				createUserID(BigInt(match[1]!)),
			);

			const {message, enqueueDeferredEmbeds} = await ctx.get('channelService').messages.persistence.createMessage({
				messageId,
				channelId,
				user: author,
				type: messageReference ? MessageTypes.REPLY : MessageTypes.DEFAULT,
				content: body.content,
				flags: body.flags,
				attachments: attachments.length > 0 ? attachments : undefined,
				attachmentUploadUserId: author.id,
				messageReference,
				guildId: channel.guildId,
				channel,
				mentionData: {
					flags: body.flags,
					mentionUserIds,
					mentionRoleIds: [],
					mentionChannelIds: [],
					mentionEveryone: false,
				},
				allowEmbeds: true,
				skipAuthorAck: true,
			});
			let stored = message;
			if (body.edited_timestamp) {
				const row = message.toRow();
				stored = await channelRepository.messages.upsertMessage(
					{...row, edited_timestamp: new Date(body.edited_timestamp)},
					row,
				);
			}
			await channelRepository.messages.lowerCreatedBucket(channelId, BucketUtils.makeBucket(messageId));
			await enqueueDeferredEmbeds();
			if (channel.indexedAt != null) {
				void ctx.get('channelService').messages.search.indexMessage(stored, author.isBot);
			}
			return ctx.json({id: stored.id.toString(), created: true});
		},
	);
}
