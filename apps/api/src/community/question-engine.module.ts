import { Module } from '@nestjs/common';

import { MarketHealthModule } from '../market/health.module';
import { AnthropicQuestionModel } from './anthropic-question-model';
import { QUESTION_MODEL, QuestionEngineService } from './question-engine.service';

/**
 * The question engine on its own, so the resolution path can feed §2.9's loop
 * without importing the whole community shelf — `CommunityModule` already
 * depends on resolution, and a cycle would be the price of convenience.
 *
 * The model is provided by a factory that returns `null` when no key is
 * configured, so an unconfigured deployment fails closed at the call rather than
 * at boot: screening is unavailable, and everything that does not need a model
 * keeps working.
 */
@Module({
  imports: [MarketHealthModule],
  providers: [
    QuestionEngineService,
    { provide: QUESTION_MODEL, useFactory: () => AnthropicQuestionModel.create() },
  ],
  exports: [QuestionEngineService],
})
export class CommunityQuestionModule {}
