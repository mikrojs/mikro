// A type-only declaration is erased by every TypeScript transform: no file to
// trace. Inline `type` specifiers keep the import as a side effect under
// verbatimModuleSyntax, so that one still counts.
import type {A} from './erased'
import {type C} from './kept'

export type {B} from './erased-too'
export type * from './erased-star'

export const value: A | C | undefined = undefined
