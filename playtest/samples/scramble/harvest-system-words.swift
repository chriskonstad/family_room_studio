// harvest-system-words.swift — AUTHORING ONLY, macOS only, run by make-dict.mjs.
//
// Pulls an English word list out of the Mac's own spelling dictionary, which is
// the one that knows `began`, `epiphany`, `cilantro`, `funniest` and `hashtags`.
// Webster's 1913 — the only word list that ships with a Mac at a known path —
// knows none of those, and a player being told BEGAN is not a word while the
// whole table watches is the worst thing this game can do.
//
// NSSpellChecker can only be asked two things: "is this a word" and "what words
// start with this". The second one enumerates, but it answers at most CAP words
// per prefix. So this walks the alphabet and goes a letter deeper wherever the
// answer came back full, which is exactly where there is more behind it. Roughly
// 85,000 questions, about two and a half minutes, ~96,000 words.
//
// The shipped game never calls any of this. The system dictionary differs
// between macOS versions and does not exist on a phone at all, so asking it at
// play time would make the same grid score differently on different devices and
// end replayability — the one property every test here depends on. It is read
// once, here, and baked into dict.js.

import AppKit

let checker = NSSpellChecker.shared
let tag = NSSpellChecker.uniqueSpellDocumentTag()
let CAP = 20                     // what `completions` will return before it truncates
let MAX_PREFIX = 8               // SCRAMBLE's longest word
let letters = Array("abcdefghijklmnopqrstuvwxyz")

var found = Set<String>()
var queries = 0

func completions(_ prefix: String) -> [String] {
    queries += 1
    let range = NSRange(location: 0, length: (prefix as NSString).length)
    return checker.completions(forPartialWordRange: range, in: prefix,
                               language: "en", inSpellDocumentWithTag: tag) ?? []
}

func crawl(_ prefix: String) {
    let page = completions(prefix)
    for word in page { found.insert(word) }
    // A full page means the list was cut off, so there is more under this prefix.
    if page.count >= CAP && prefix.count < MAX_PREFIX {
        for letter in letters { crawl(prefix + String(letter)) }
    }
}

let started = Date()
for letter in letters { crawl(String(letter)) }

/* The dictionary capitalises some entries it still considers ordinary words —
 * `Taco` comes back capitalised, and so does `Emily`. Lowercase it and ask: a
 * real word is still spelled correctly in lower case, a name is not. */
func isOrdinaryWord(_ word: String) -> Bool {
    let range = checker.checkSpelling(of: word, startingAt: 0, language: "en",
                                      wrap: false, inSpellDocumentWithTag: tag, wordCount: nil)
    return range.location == NSNotFound
}

var kept = Set<String>()
for word in found {
    let lower = word.lowercased()
    guard lower.count >= 3, lower.count <= MAX_PREFIX,
          lower.allSatisfy({ $0.isASCII && $0.isLetter })
    else { continue }
    if word == lower || isOrdinaryWord(lower) { kept.insert(lower) }
}

let elapsed = Date().timeIntervalSince(started)
FileHandle.standardError.write(
    "  \(queries) queries · \(found.count) raw · \(kept.count) usable · \(String(format: "%.0f", elapsed))s\n"
        .data(using: .utf8)!)
for word in kept.sorted() { print(word) }
