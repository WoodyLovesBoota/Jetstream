// Static stopword dictionary for the Surge tokenizer — "words used at any time" are
// not a trend.
//
// Three tiers:
//   (1) Standard English function words — from the NLTK family, length 3+ only (2
//       characters and under are already filtered by the regex). n't contractions get
//       cut at the apostrophe and surface as "don"/"isn", so the stems are included.
//   (2) High-frequency English everyday words — not function words, but ever-present
//       and carrying no burst signal. Modals and contractions (including
//       apostrophe-dropped spellings), the top-frequency verbs, adjectives, adverbs
//       and nouns, time words, number words, internet interjections and
//       abbreviations, and platform boilerplate.
//   (3) Function words of the major Latin languages — the top function words of the
//       high-volume languages on Bluesky (PT, ES, FR, DE, IT, NL, ID, TR). CJK is
//       absent because only hashtags are tracked for it.
//
// Inclusion test: "has this single word ever been useful when it surfaced in the
// ranking?" — if not, it goes in. Languages and spellings not covered here are caught
// by occupancy via the dynamic ambient rule (surge.ts).
//
// Spelling collisions across languages are listed once, lowercased. Collisions that
// kill the English sense are noted in comments — most notably "war" (the German past
// tense of "to be" ≫ the frequency of the English noun).

export const STOPWORDS = new Set([
  // ── (1) English function words (NLTK family, 3+ chars) ────────────
  "about", "above", "after", "again", "against", "ain", "all", "and", "any",
  "are", "aren", "because", "been", "before", "being", "below", "between",
  "both", "but", "can", "couldn", "did", "didn", "does", "doesn", "doing",
  "don", "down", "during", "each", "few", "for", "from", "further", "had",
  "hadn", "has", "hasn", "have", "haven", "having", "her", "here", "hers",
  "herself", "him", "himself", "his", "how", "isn", "its", "itself", "just",
  "mightn", "more", "most", "mustn", "myself", "needn", "nor", "not", "now",
  "off", "once", "only", "other", "our", "ours", "ourselves", "out", "over",
  "own", "same", "shan", "she", "should", "shouldn", "some", "such", "than",
  "that", "the", "their", "theirs", "them", "themselves", "then", "there",
  "these", "they", "this", "those", "through", "too", "under", "until",
  "very", "was", "wasn", "were", "weren", "what", "when", "where", "which",
  "while", "who", "whom", "why", "will", "with", "won", "wouldn", "you",
  "your", "yours", "yourself", "yourselves",

  // Web structure tokens — noise left behind when a bare, scheme-less domain
  // (www.foo.com) slips past URL stripping. It is not content but ever-present
  // background, so it pollutes the burst signal.
  "com", "www", "http", "https", "org", "net", "amp",

  // ── (2) High-frequency English everyday words ──────────────────────
  // Modals and negative/personal contractions (incl. apostrophe-dropped spellings)
  "would", "could", "cannot", "cant", "wont", "dont", "didnt", "doesnt",
  "isnt", "wasnt", "arent", "werent", "wouldnt", "couldnt", "shouldnt",
  "aint", "youre", "youll", "youve", "theyre", "theyve", "theyll", "thats",
  "whats", "whos", "hes", "shes", "weve", "ive", "ill", "lets",
  "gonna", "gotta", "wanna", "kinda", "sorta", "tryna",
  // Top-frequency verbs (+ their main inflections)
  "get", "gets", "got", "gotten", "getting", "make", "makes", "made",
  "making", "take", "takes", "took", "taken", "taking", "come", "comes",
  "came", "coming", "going", "goes", "went", "gone", "know", "knows",
  "knew", "known", "knowing", "think", "thinks", "thought", "thinking",
  "see", "sees", "saw", "seen", "seeing", "want", "wants", "wanted",
  "need", "needs", "needed", "look", "looks", "looked", "looking",
  "feel", "feels", "felt", "feeling", "say", "says", "said", "saying",
  "tell", "tells", "told", "telling", "use", "uses", "used", "using",
  "find", "finds", "found", "give", "gives", "gave", "given", "giving",
  "keep", "keeps", "kept", "put", "puts", "mean", "means", "meant",
  "watch", "watches", "watched", "watching", "like", "likes", "liked",
  "love", "loves", "loved", "loving", "talk", "talks", "talked", "talking",
  "call", "calls", "called", "try", "tries", "tried", "trying",
  "happen", "happens", "happened",
  // Top-frequency adjectives, adverbs, and determiner-like words
  "good", "great", "bad", "best", "better", "worse", "worst", "big",
  "small", "little", "long", "old", "new", "real", "really", "right",
  "wrong", "sure", "well", "also", "always", "never", "ever", "every",
  "actually", "literally", "probably", "maybe", "pretty", "much", "many",
  "lot", "lots", "even", "still", "yet", "already", "away", "back",
  "first", "last", "next", "else", "enough", "though", "although",
  "anyway", "instead", "together", "everyone", "everybody", "someone",
  "somebody", "anyone", "anybody", "nothing", "something", "anything",
  "everything", "whatever", "whenever", "wherever",
  // Prepositions, conjunctions, and conjunctive adverbs — purely structural words
  // that will never be a trend ("into" is the textbook case of one that should have
  // been here). If this tier is thin, they leak into the surging list during the
  // early-session window where the baseline is still immature.
  "into", "onto", "unto", "upon", "within", "without", "toward", "towards",
  "among", "amongst", "along", "across", "around", "apart", "aside",
  "beyond", "behind", "beneath", "beside", "besides", "despite",
  "throughout", "underneath", "unless", "whether", "either", "neither",
  "however", "therefore", "thereby", "moreover", "furthermore", "meanwhile",
  "otherwise", "nonetheless", "nevertheless", "regardless", "perhaps",
  "indeed", "rather", "quite", "somewhat", "somehow", "anyhow", "anywhere",
  "everywhere", "nowhere", "elsewhere", "somewhere", "hence", "thus",
  "versus", "whoever", "whichever", "whereas", "whereby", "wherein",
  // Filler adverbs — perpetual modifiers
  "basically", "essentially", "seriously", "honestly", "obviously",
  "apparently", "supposedly", "totally", "definitely", "certainly",
  "exactly", "simply", "merely", "mostly", "usually", "generally",
  "normally", "typically", "currently", "recently", "lately", "finally",
  "eventually", "suddenly", "immediately", "completely", "absolutely",
  "particularly", "especially", "specifically", "clearly", "truly",
  "mainly", "nearly", "almost", "fully", "hardly", "barely", "rarely",
  "often", "sometimes",
  // Light verbs, modals, and frequent cognition/speech verbs — sentence skeleton
  // rather than content (the "let"/"seem" family)
  "let", "lets", "letting", "seem", "seems", "seemed", "seeming",
  "become", "becomes", "became", "becoming", "remain", "remains",
  "appear", "appears", "appeared", "ought", "shall", "must", "able",
  "unable", "used", "ask", "asks", "asked", "asking", "guess", "wonder",
  "believe", "believes", "believed", "suppose", "supposed", "consider",
  "realize", "realized", "remember", "remembers", "remembered", "forget",
  "forgot", "understand", "understood", "explain", "mention", "notice",
  "noticed", "matter", "matters", "care", "cares", "mind",
  // Ever-present adjectives + language meta-words ("word"/"words" belong here too)
  "important", "different", "similar", "possible", "impossible",
  "available", "certain", "various", "several", "single", "whole",
  "entire", "actual", "current", "recent", "final", "simple", "true",
  "false", "full", "empty", "nice", "cool", "fine", "weird", "crazy",
  "funny", "serious", "special", "normal", "usual", "common", "rare",
  "easy", "hard", "difficult", "major", "minor", "main", "word", "words",
  // Time words and generic nouns — perpetual background
  "thing", "things", "stuff", "time", "times", "day", "days", "today",
  "tonight", "tomorrow", "yesterday", "week", "weeks", "month", "months",
  "year", "years", "hour", "hours", "minute", "minutes", "second",
  "seconds", "morning", "night", "people", "person", "man", "men",
  "woman", "women", "guy", "guys", "way", "ways", "life", "world",
  // Common profanity — perpetual background in social text
  "shit", "fuck", "fucking", "fucked", "damn", "hell", "ass", "bitch",
  // Number words
  "zero", "one", "two", "three", "four", "five", "six", "seven", "eight",
  "nine", "ten", "hundred", "thousand", "million", "billion", "third",
  // Internet interjections, abbreviations, and laughter
  "lol", "lmao", "lmfao", "omg", "wtf", "tbh", "idk", "imo", "imho",
  "irl", "smh", "ngl", "btw", "tho", "pls", "plz", "thx", "thanks",
  "thank", "please", "yeah", "yea", "yep", "yes", "nah", "nope", "okay",
  "bruh", "bro", "dude", "haha", "hahaha", "hahahaha", "jaja", "jajaja",
  "jajajaja", "kkk", "kkkk", "kkkkk", "rsrs",
  // Platform boilerplate — always-present background on this deck
  "bluesky", "bsky", "post", "posts", "posting", "follow", "followers",
  "following",

  // ── (3) Latin-language function words ──────────────────────────────
  // Portuguese (spellings shared with ES appear only here: que, como, para, por,
  // esta, todo …)
  "que", "nao", "não", "com", "uma", "mas", "mais", "como", "isso",
  "essa", "esse", "isto", "este", "esta", "está", "estao", "estão",
  "estou", "voce", "você", "voces", "vocês", "ele", "ela", "eles",
  "elas", "meu", "minha", "seu", "sua", "tem", "ter", "tinha", "ser",
  "sou", "foi", "era", "sao", "são", "dos", "das", "nas", "nos", "num",
  "numa", "pra", "pro", "para", "por", "muito", "muita", "bem", "entao",
  "então", "quando", "porque", "aqui", "agora", "hoje", "tudo", "todo",
  "toda", "todos", "todas", "gente", "cara", "sim", "nem", "ate", "até",
  "ainda", "coisa", "dia", "ano", "vai", "vou", "fazer", "faz", "fez",
  // Spanish (only those that do not overlap with PT)
  "los", "las", "una", "unos", "unas", "del", "pero", "más", "esto",
  "ese", "esa", "eso", "son", "soy", "muy", "bien", "nada", "algo",
  "ahora", "aquí", "hoy", "tengo", "tiene", "tienes", "hay", "sin",
  "cuando", "gracias", "hola", "ella", "ellos", "ellas", "usted",
  "estás", "estan", "están", "tambien", "también", "asi", "así",
  "vamos", "vale",
  // French
  "les", "des", "une", "est", "pas", "pour", "avec", "dans", "sur",
  "qui", "quoi", "moi", "toi", "vous", "nous", "ils", "elle", "elles",
  "mon", "mes", "ton", "tes", "ses", "notre", "votre", "tres", "très",
  "tout", "tous", "toute", "toutes", "faire", "fait", "comme", "alors",
  "aussi", "merci", "oui", "non", "plus", "quand", "meme", "même",
  "encore", "deja", "déjà",
  // German — "war" (past tense of "to be") kills the English "war" along with it: the
  // function-word volume far exceeds the English signal, and actual war news surfaces
  // through country names and hashtags.
  "und", "der", "die", "das", "den", "dem", "ein", "eine", "einen",
  "einem", "einer", "ist", "sind", "war", "waren", "nicht", "auch",
  "aber", "wenn", "wie", "wer", "wir", "ihr", "sie", "ich", "mich",
  "mir", "mit", "fur", "für", "auf", "aus", "bei", "nur", "noch",
  "schon", "mal", "kein", "keine", "mehr", "sehr", "gut", "dass",
  "muss", "kann", "haben", "habe", "hat", "hatte", "wird", "werden",
  "wurde", "uns", "euch", "dann", "denn", "doch", "heute", "jetzt",
  "immer", "alles", "alle", "oder", "zum", "zur", "vom", "beim",
  "nach", "uber", "über",
  // Italian
  "che", "per", "della", "delle", "degli", "sono", "anche", "questo",
  "questa", "piu", "più", "perche", "perché", "cosi", "così", "gli",
  "alla", "alle", "nel", "nella", "fatto", "bene", "tutto", "tutti",
  "tutte", "grazie", "ciao", "sempre", "ancora", "essere", "hanno",
  "siamo", "molto", "dove", "quindi",
  // Dutch
  "het", "een", "van", "voor", "met", "dat", "dit", "zijn", "hebben",
  "heeft", "heb", "niet", "maar", "ook", "als", "bij", "naar", "wat",
  "wel", "nog", "heel", "goed", "deze", "dan", "toch", "echt", "gaan",
  "gaat", "doen", "mijn", "ons", "hun", "veel", "meer", "uit", "aan",
  // Indonesian
  "yang", "dan", "ini", "itu", "ada", "tidak", "gak", "nggak", "aku",
  "kamu", "dia", "kita", "kami", "mau", "udah", "sudah", "belum",
  "bisa", "aja", "saja", "banget", "kalo", "kalau", "juga", "sama",
  "lagi", "buat", "tapi", "jadi", "gue", "gua", "kan", "dengan",
  "untuk", "karena", "seperti", "masih", "akan", "harus", "orang",
  "hari",
  // Turkish
  "bir", "icin", "için", "ama", "gibi", "cok", "çok", "ben", "sen",
  "biz", "siz", "var", "yok", "bana", "beni", "ile", "daha", "sey",
  "şey", "kadar", "sonra", "simdi", "şimdi", "bugun", "bugün", "evet",
  "hayir", "hayır",
]);
