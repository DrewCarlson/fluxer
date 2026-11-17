// SPDX-License-Identifier: AGPL-3.0-or-later

// Fluxcord patch: no mail to reserved .invalid addresses.

import type {EmailConfig, EmailMessage, IEmailProvider} from '@pkgs/email/src/EmailProviderTypes';
import {EmailService, isReservedUndeliverable} from '@pkgs/email/src/EmailService';
import {describe, expect, it} from 'vitest';

const CONFIG: EmailConfig = {
	enabled: true,
	fromEmail: 'noreply@example.com',
	fromName: 'Fluxer',
	appBaseUrl: 'https://example.com',
	apiBaseUrl: 'https://api.example.com',
	appealsEmail: 'appeals@example.com',
	privacyEmail: 'privacy@example.com',
	safetyEmail: 'safety@example.com',
	supportEmail: 'support@example.com',
	productName: 'Fluxer',
	marketingBaseUrl: 'https://example.com',
	staticCdnBaseUrl: 'https://static.example.com',
	legalAddress: 'Example',
	brandLogo: true,
};

describe('Fluxcord: reserved .invalid addresses', () => {
	it('recognizes addresses under .invalid only', () => {
		expect(isReservedUndeliverable('dc123@ghosts.invalid')).toBe(true);
		expect(isReservedUndeliverable(' Someone@INVALID ')).toBe(true);
		expect(isReservedUndeliverable('user@invalid.example.com')).toBe(false);
		expect(isReservedUndeliverable('user@example.com')).toBe(false);
	});

	it('sends nothing to them, and still sends to other addresses', async () => {
		const sent: Array<EmailMessage> = [];
		const provider: IEmailProvider = {
			sendEmail: async (message) => {
				sent.push(message);
				return true;
			},
		};
		const service = new EmailService(CONFIG, provider);

		const skipped = await service.send('password_reset', 'dc123@ghosts.invalid', {resetToken: 'tok'}, 'en-US');
		await service.send('password_reset', 'user@example.com', {resetToken: 'tok'}, 'en-US');

		expect(skipped).toBe(true);
		expect(sent.map((message) => message.to)).toEqual(['user@example.com']);
	});
});
