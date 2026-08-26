// Tiny dependency-free i18n. English source strings are the keys; locale files in
// src/locales/ map them to translations and are lazy-loaded (Vite code-splits each
// import.meta.glob entry), so the initial bundle stays English-only.
// Exercise instructions come from separately generated packs in src/instr/ (one per
// language, from the upstream dataset) — loaded on demand (when an exercise card is
// opened) so a ~1 MB pack of every exercise's steps never blocks app startup.
import { useSyncExternalStore } from 'react'

// UI languages. de/pt have no instruction pack upstream — instructions fall back to English.
export const LANGS = {
  en: 'English', de: 'Deutsch', es: 'Español', fr: 'Français', it: 'Italiano',
  pt: 'Português', pl: 'Polski', tr: 'Türkçe', ru: 'Русский', zh: '中文',
  ko: '한국어', hi: 'हिन्दी'
}
export const INSTR_LANGS = ['en', 'es', 'fr', 'it', 'tr', 'ru', 'zh', 'hi', 'pl', 'ko']
// Languages with an exercise-name pack (translated exercise titles).
export const NAMES_LANGS = ['ru']
const DATE_LOCALES = {
  en: 'en-GB', de: 'de-DE', es: 'es-ES', fr: 'fr-FR', it: 'it-IT', pt: 'pt-PT',
  pl: 'pl-PL', tr: 'tr-TR', ru: 'ru-RU', zh: 'zh-CN', ko: 'ko-KR', hi: 'hi-IN'
}

const localePacks = import.meta.glob('../locales/*.js')
const instrPacks = import.meta.glob('../instr/*.js')
const namePacks = import.meta.glob('../names/*.js')

let lang = 'en'
let dict = {}
let instr = null            // { exId: [steps] } for the current language, null = English
let names = null            // { exId: translated title } for the current language, null = English
let version = 0
const subs = new Set()
const notify = () => { version++; subs.forEach(f => f()) }

export const getLang = () => lang
export const dateLocale = () => DATE_LOCALES[lang] || 'en-GB'

// Translate a source string; {0},{1}… are replaced with args (also on the English fallback).
export function t(s, ...args) {
  let v = dict[s] || s
  for (let i = 0; i < args.length; i++) v = v.replaceAll('{' + i + '}', args[i])
  return v
}
// Instructions for an exercise in the current language (English steps as fallback).
export const instrFor = ex => (instr && instr[ex.id]) || ex.st || []
// Translated title for an exercise in the current language (English name as fallback).
export const exName = ex => (names && names[ex.id]) || ex.n || ''

// Loads the instruction pack for the current language on demand (the packs are big —
// a full catalogue of steps per exercise — so they load only when the exercise card is
// opened, not at app startup). Resolves immediately if instructions are already here or
// the language has none (English/unsupported → English steps fallback).
let instrLoading = null
export async function ensureInstr() {
  if (instrLoading) return instrLoading
  if (lang === 'en' || !INSTR_LANGS.includes(lang)) return
  const l = lang
  instrLoading = (async () => {
    try { instr = (await instrPacks['../instr/' + l + '.js']()).default } catch (e) { instr = null }
    if (lang === l) notify()
  })()
  return instrLoading
}

export async function setLang(l) {
  if (!LANGS[l]) l = 'en'
  if (l === lang && version > 0) return
  lang = l
  instrLoading = null
  try {
    dict = l === 'en' ? {} : (await localePacks['../locales/' + l + '.js']()).default
    names = l === 'en' || !NAMES_LANGS.includes(l) ? null : (await namePacks['../names/' + l + '.js']()).default
  } catch (e) { dict = {}; names = null }
  // instructions intentionally NOT loaded here — they come with ensureInstr() on demand
  instr = null
  notify()
}

// Re-renders the subscribing component (and its children) whenever the language changes.
export function useLang() {
  return useSyncExternalStore(fn => { subs.add(fn); return () => subs.delete(fn) }, () => version)
}
