import { ModuleRef } from '@nestjs/core';
import { InjectConnection } from '@nestjs/typeorm';
import {
    createProxyHandler,
    EventBus,
    JobQueue,
    JobQueueService,
    Logger,
    OnVendureBootstrap,
    OnVendureClose,
    PluginCommonModule,
    RuntimeVendureConfig,
    Type,
    VendurePlugin,
    WorkerService,
} from '@vendure/core';
import { Connection } from 'typeorm';

import { isDevModeOptions } from './common';
import { EMAIL_PLUGIN_OPTIONS } from './constants';
import { DevMailbox } from './dev-mailbox';
import { EmailProcessor } from './email-processor';
import { EmailProcessorController } from './email-processor.controller';
import { EmailEventHandler, EmailEventHandlerWithAsyncData } from './event-handler';
import {
    EmailPluginDevModeOptions,
    EmailPluginOptions,
    EmailWorkerMessage,
    EventWithAsyncData,
    EventWithContext,
    IntermediateEmailDetails,
} from './types';

/**
 * @description
 * The EmailPlugin creates and sends transactional emails based on Vendure events. It uses an [MJML](https://mjml.io/)-based
 * email generator to generate the email body and [Nodemailer](https://nodemailer.com/about/) to send the emais.
 *
 * ## Installation
 *
 * `yarn add \@vendure/email-plugin`
 *
 * or
 *
 * `npm install \@vendure/email-plugin`
 *
 * @example
 * ```ts
 * import { defaultEmailHandlers, EmailPlugin } from '\@vendure/email-plugin';
 *
 * const config: VendureConfig = {
 *   // Add an instance of the plugin to the plugins array
 *   plugins: [
 *     new EmailPlugin({
 *       handlers: defaultEmailHandlers,
 *       templatePath: path.join(__dirname, 'vendure/email/templates'),
 *       transport: {
 *         type: 'smtp',
 *         host: 'smtp.example.com',
 *         port: 587,
 *         auth: {
 *           user: 'username',
 *           pass: 'password',
 *         }
 *       },
 *     }),
 *   ],
 * };
 * ```
 *
 * ## Email templates
 *
 * In the example above, the plugin has been configured to look in `<app-root>/vendure/email/templates`
 * for the email template files. If you used `\@vendure/create` to create your application, the templates will have
 * been copied to that location during setup.
 *
 * If you are installing the EmailPlugin separately, then you'll need to copy the templates manually from
 * `node_modules/\@vendure/email-plugin/templates` to a location of your choice, and then point the `templatePath` config
 * property at that directory.
 *
 * ## Customizing templates
 *
 * Emails are generated from templates which use [MJML](https://mjml.io/) syntax. MJML is an open-source HTML-like markup
 * language which makes the task of creating responsive email markup simple. By default, the templates are installed to
 * `<project root>/vendure/email/templates` and can be freely edited.
 *
 * Dynamic data such as the recipient's name or order items are specified using [Handlebars syntax](https://handlebarsjs.com/):
 *
 * ```HTML
 * <p>Dear {{ order.customer.firstName }} {{ order.customer.lastName }},</p>
 *
 * <p>Thank you for your order!</p>
 *
 * <mj-table cellpadding="6px">
 *   {{#each order.lines }}
 *     <tr class="order-row">
 *       <td>{{ quantity }} x {{ productVariant.name }}</td>
 *       <td>{{ productVariant.quantity }}</td>
 *       <td>{{ formatMoney totalPrice }}</td>
 *     </tr>
 *   {{/each}}
 * </mj-table>
 * ```
 *
 * ### Handlebars helpers
 *
 * The following helper functions are available for use in email templates:
 *
 * * `formatMoney`: Formats an amount of money (which are always stored as integers in Vendure) as a decimal, e.g. `123` => `1.23`
 * * `formatDate`: Formats a Date value with the [dateformat](https://www.npmjs.com/package/dateformat) package.
 *
 * ## Extending the default email handlers
 *
 * The `defaultEmailHandlers` array defines the default handlers such as for handling new account registration, order confirmation, password reset
 * etc. These defaults can be extended by adding custom templates for languages other than the default, or even completely new types of emails
 * which respond to any of the available [VendureEvents](/docs/typescript-api/events/). See the {@link EmailEventHandler} documentation for
 * details on how to do so.
 *
 * ## Dev mode
 *
 * For development, the `transport` option can be replaced by `devMode: true`. Doing so configures Vendure to use the
 * file transport (See {@link FileTransportOptions}) and outputs emails as rendered HTML files in the directory specified by the
 * `outputPath` property.
 *
 * ```ts
 * EmailPlugin.init({
 *   devMode: true,
 *   handlers: defaultEmailHandlers,
 *   templatePath: path.join(__dirname, 'vendure/email/templates'),
 *   outputPath: path.join(__dirname, 'test-emails'),
 *   mailboxPort: 5003,
 * })
 * ```
 *
 * ### Dev mailbox
 *
 * In dev mode, specifying the optional `mailboxPort` will start a webmail-like interface available at the `/mailbox` path, e.g.
 * http://localhost:3000/mailbox. This is a simple way to view the output of all emails generated by the EmailPlugin while in dev mode.
 *
 * @docsCategory EmailPlugin
 */
@VendurePlugin({
    imports: [PluginCommonModule],
    providers: [{ provide: EMAIL_PLUGIN_OPTIONS, useFactory: () => EmailPlugin.options }],
    workers: [EmailProcessorController],
    configuration: (config) => EmailPlugin.configure(config),
})
export class EmailPlugin implements OnVendureBootstrap, OnVendureClose {
    private static options: EmailPluginOptions | EmailPluginDevModeOptions;
    private devMailbox: DevMailbox | undefined;
    private jobQueue: JobQueue<IntermediateEmailDetails> | undefined;
    private testingProcessor: EmailProcessor | undefined;

    /** @internal */
    constructor(
        private eventBus: EventBus,
        @InjectConnection() private connection: Connection,
        private moduleRef: ModuleRef,
        private workerService: WorkerService,
        private jobQueueService: JobQueueService,
    ) {}

    /**
     * Set the plugin options.
     */
    static init(options: EmailPluginOptions | EmailPluginDevModeOptions): Type<EmailPlugin> {
        this.options = options;
        return EmailPlugin;
    }

    /** @internal */
    static configure(config: RuntimeVendureConfig): RuntimeVendureConfig {
        if (isDevModeOptions(this.options) && this.options.mailboxPort !== undefined) {
            const route = 'mailbox';
            config.apiOptions.middleware.push({
                handler: createProxyHandler({ port: this.options.mailboxPort, route, label: 'Dev Mailbox' }),
                route,
            });
        }
        return config;
    }

    /** @internal */
    async onVendureBootstrap(): Promise<void> {
        const options = EmailPlugin.options;

        if (isDevModeOptions(options) && options.mailboxPort !== undefined) {
            this.devMailbox = new DevMailbox();
            this.devMailbox.serve(options);
            this.devMailbox.handleMockEvent((handler, event) => this.handleEvent(handler, event));
        }

        await this.setupEventSubscribers();

        if (!isDevModeOptions(options) && options.transport.type === 'testing') {
            // When running tests, we don't want to go through the JobQueue system,
            // so we just call the email sending logic directly.
            this.testingProcessor = new EmailProcessor(options);
            await this.testingProcessor.init();
        } else {
            this.jobQueue = this.jobQueueService.createQueue({
                name: 'send-email',
                concurrency: 5,
                process: (job) => {
                    this.workerService.send(new EmailWorkerMessage(job.data)).subscribe({
                        complete: () => job.complete(),
                        error: (err) => job.fail(err),
                    });
                },
            });
        }
    }

    /** @internal */
    async onVendureClose() {
        if (this.devMailbox) {
            this.devMailbox.destroy();
        }
    }

    private async setupEventSubscribers() {
        for (const handler of EmailPlugin.options.handlers) {
            this.eventBus.ofType(handler.event).subscribe((event) => {
                return this.handleEvent(handler, event);
            });
        }
    }

    private async handleEvent(
        handler: EmailEventHandler | EmailEventHandlerWithAsyncData<any>,
        event: EventWithContext,
    ) {
        Logger.debug(`Handling event "${handler.type}"`, 'EmailPlugin');
        const { type } = handler;
        try {
            if (handler instanceof EmailEventHandlerWithAsyncData) {
                (event as EventWithAsyncData<EventWithContext, any>).data = await handler._loadDataFn({
                    event,
                    connection: this.connection,
                    inject: (t) => this.moduleRef.get(t, { strict: false }),
                });
            }
            const result = await handler.handle(event as any, EmailPlugin.options.globalTemplateVars);
            if (!result) {
                return;
            }
            if (this.jobQueue) {
                await this.jobQueue.add(result);
            } else if (this.testingProcessor) {
                await this.testingProcessor.process(result);
            }
        } catch (e) {
            Logger.error(e.message, 'EmailPlugin', e.stack);
        }
    }
}
