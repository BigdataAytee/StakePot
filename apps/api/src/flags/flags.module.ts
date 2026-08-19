import { Global, Module } from '@nestjs/common';

import { FlagsService } from './flags.service';

/**
 * Global, like the config module: a flag is checked from wherever the gated
 * code happens to live, and threading an import through every module that
 * might one day want one is how flags stop being reached for.
 */
@Global()
@Module({
  providers: [FlagsService],
  exports: [FlagsService],
})
export class FlagsModule {}
