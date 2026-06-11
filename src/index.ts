/**
 * Public exports for @gmac20191/copy-pipeline.
 *
 * The library entrypoint. The thin CLI shell in `bin/copy-pipeline.ts` wraps
 * these for terminal use; an agent-facing skill at ~/.claude/skills/copy-pipeline
 * (TBD) wraps the CLI.
 */

export type {
  BrandKit,
  Brief,
  Variant,
  Finding,
  GradedVariant,
  GroundingChunk,
  GenerationRun,
  GenerateOptions,
  ModelId,
} from './types.js'

export { loadBrandKit, findBrandKitPath, brandKitSchema } from './brand-kit.js'

export type { Grader, GraderContext, GraderResult } from './grader/index.js'
export {
  GRADER_REGISTRY,
  registerGrader,
  defaultGraders,
} from './grader/index.js'
export { brandReviewGrader } from './grader/brand-review.js'
export { llmVoiceJudgeGrader } from './grader/llm-judge.js'

export type { GroundingSource, GroundingQuery } from './grounding/index.js'
export {
  GROUNDING_REGISTRY,
  registerGroundingSource,
  defaultGroundingSources,
} from './grounding/index.js'
export { pgvectorSource } from './grounding/pgvector.js'

export type {
  DestinationAdapter,
  PublishArgs,
  ShipResult,
  PreflightArgs,
  PreflightResult,
} from './destination/index.js'
export {
  DESTINATION_REGISTRY,
  registerDestination,
  defaultDestinations,
} from './destination/index.js'
export { outputFileDestination } from './destination/output-file.js'
export { atlassianMcpDestination } from './destination/atlassian-mcp.js'
export { slackMcpDestination } from './destination/slack-mcp.js'
export { gitCommitPrDestination } from './destination/git-commit-pr.js'
export type {
  GoogleDriveDestinationConfig,
  GoogleDriveDestinationConfigParsed,
  GoogleDriveDestinationOptions,
  DriveUploadClient,
} from './destination/google-drive.js'
export {
  googleDriveDestination,
  createGoogleDriveDestination,
} from './destination/google-drive.js'

export type {
  Verifier,
  VerifierContext,
  VerifyArgs,
  VerifyResult,
  DiscoveredRef,
  EvidenceRef,
  RegisterVerifierFn,
} from './verifier/index.js'
export {
  VERIFIER_REGISTRY,
  NEEDS_EVIDENCE_PREFIX,
  registerVerifier,
  getVerifierForRef,
  defaultVerifiers,
} from './verifier/index.js'
export { fileVerifier } from './verifier/file.js'
export type {
  NotebookLMCall,
  NotebookLMRunResult,
  NotebookLMCitation,
  NotebookLMVerifierConfig,
  JudgeFn,
  JudgeResult,
  JudgeVerdict,
} from './verifier/notebooklm.js'
export {
  notebookLMVerifier,
  createNotebookLMVerifier,
  createDefaultJudge,
  buildJudgePrompt,
} from './verifier/notebooklm.js'
export type {
  ParsedClaim,
  ClaimVerdict,
  VerifiedClaim,
  VerificationReport,
  VerifyClaimsOptions,
} from './verifier/dispatcher.js'
export { parseClaims, verifyClaims } from './verifier/dispatcher.js'

export type {
  ClaimExtractor,
  ClaimExtractorContext,
  ExtractedClaim,
  ExtractionResult,
} from './extractor/index.js'
export {
  EXTRACTOR_REGISTRY,
  registerExtractor,
  defaultExtractors,
} from './extractor/index.js'
export type { DiscoveryMenu } from './extractor/menu.js'
export { buildDiscoveryMenu, renderMenu } from './extractor/menu.js'
export type { WrapResult } from './extractor/wrap.js'
export { wrapClaims } from './extractor/wrap.js'
export type {
  LLMExtractorCall,
  LLMExtractorCallArgs,
  LLMExtractorCallResult,
  CreateLLMExtractorOptions,
} from './extractor/llm.js'
export {
  llmClaimExtractor,
  createLLMExtractor,
  buildExtractorPrompt,
} from './extractor/llm.js'

export { ship } from './ship.js'

export { generate } from './generate.js'

export type { PickArgs, PickResult, PickRecorder } from './pick.js'
export { recordPick } from './pick.js'

export type {
  BriefSource,
  BriefSourceContext,
  BriefEvent,
} from './source/index.js'
export {
  INPUT_SOURCE_REGISTRY,
  registerInputSource,
  defaultInputSources,
} from './source/index.js'

export type {
  WatchAllOptions,
  WatchLogger,
  WatchLogLevel,
  FilenameContext,
} from './watch.js'
export { watchAll, applyFilenameTemplate } from './watch.js'

export type {
  PublishedVariant,
  PublishRecord,
  Sidecar,
  PickScoreEmitter,
  PickerLoopOptions,
  PickerLogger,
  PickerLogLevel,
} from './picker.js'
export {
  buildDefaultEmitter,
  defaultSidecarPath,
  pickerLoop,
  processOneIteration,
  readSidecar,
  recordPublish,
  writeSidecar,
} from './picker.js'

export type { DetectPickArgs, DetectPickResult } from './destination/index.js'
