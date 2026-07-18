// Surge 토크나이저의 정적 불용어 사전 — "아무 때나 쓰는 말"은 트렌드가 아니다.
//
// 3계층:
//   (1) 표준 영어 기능어 — NLTK 계열에서 길이 3 이상만(2자 이하는 정규식에서 걸러진다).
//       n't 축약형은 어포스트로피에서 잘려 "don"/"isn" 형태로 나오므로 어간을 포함한다.
//   (2) 영어 고빈도 일상어 — 기능어는 아니지만 상시 등장해 버스트 신호가 없는 단어들.
//       조동사·축약형(어포스트로피 탈락 표기 포함), 최상위 빈도 동사·형용사·부사·명사,
//       시간어, 숫자어, 인터넷 감탄사·약어, 플랫폼 상용어.
//   (3) 주요 라틴계 언어 기능어 — Bluesky 유량이 큰 언어(PT·ES·FR·DE·IT·NL·ID·TR)의
//       최상위 기능어. CJK는 해시태그만 추적하므로 여기 없다.
//
// 편입 기준: "이 단어 하나가 순위에 떠서 유익했던 적이 있는가?" — 없으면 넣는다.
// 여기서 못 덮는 언어·표기는 동적 앰비언트 룰(surge.ts)이 점유율로 잡는다.
//
// 언어 간 철자 충돌은 소문자 기준으로 한 번만 싣는다. 영어 쪽 의미를 죽이는 충돌은
// 주석으로 남겼다 — 대표적으로 "war"(독일어 be동사 과거 ≫ 영어 명사 빈도).

export const STOPWORDS = new Set([
  // ── (1) 영어 기능어 (NLTK 계열, 3자+) ──────────────────────────────
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

  // 웹 구조 토큰 — 스킴 없는 맨 도메인(www.foo.com)이 URL 제거를 빠져나가며 남는 잡음.
  // 콘텐츠가 아니라 항상 존재하는 배경이라 버스트 신호를 오염시킨다.
  "com", "www", "http", "https", "org", "net", "amp",

  // ── (2) 영어 고빈도 일상어 ──────────────────────────────────────────
  // 조동사·부정/인칭 축약(어포스트로피 탈락 표기 포함)
  "would", "could", "cannot", "cant", "wont", "dont", "didnt", "doesnt",
  "isnt", "wasnt", "arent", "werent", "wouldnt", "couldnt", "shouldnt",
  "aint", "youre", "youll", "youve", "theyre", "theyve", "theyll", "thats",
  "whats", "whos", "hes", "shes", "weve", "ive", "ill", "lets",
  "gonna", "gotta", "wanna", "kinda", "sorta", "tryna",
  // 최상위 빈도 동사(+주요 활용형)
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
  // 최상위 빈도 형용사·부사·한정사류
  "good", "great", "bad", "best", "better", "worse", "worst", "big",
  "small", "little", "long", "old", "new", "real", "really", "right",
  "wrong", "sure", "well", "also", "always", "never", "ever", "every",
  "actually", "literally", "probably", "maybe", "pretty", "much", "many",
  "lot", "lots", "even", "still", "yet", "already", "away", "back",
  "first", "last", "next", "else", "enough", "though", "although",
  "anyway", "instead", "together", "everyone", "everybody", "someone",
  "somebody", "anyone", "anybody", "nothing", "something", "anything",
  "everything", "whatever", "whenever", "wherever",
  // 전치사·접속·연결부사 — 순수 구조어라 트렌드가 될 일이 없다("into"가 대표적으로
  // 여기 있었어야 했다). 이 계층이 얇으면 세션 초반 baseline 미성숙 구간에서 급상승
  // 리스트로 줄줄 샌다.
  "into", "onto", "unto", "upon", "within", "without", "toward", "towards",
  "among", "amongst", "along", "across", "around", "apart", "aside",
  "beyond", "behind", "beneath", "beside", "besides", "despite",
  "throughout", "underneath", "unless", "whether", "either", "neither",
  "however", "therefore", "thereby", "moreover", "furthermore", "meanwhile",
  "otherwise", "nonetheless", "nevertheless", "regardless", "perhaps",
  "indeed", "rather", "quite", "somewhat", "somehow", "anyhow", "anywhere",
  "everywhere", "nowhere", "elsewhere", "somewhere", "hence", "thus",
  "versus", "whoever", "whichever", "whereas", "whereby", "wherein",
  // 필러 부사 — 상시 수식어
  "basically", "essentially", "seriously", "honestly", "obviously",
  "apparently", "supposedly", "totally", "definitely", "certainly",
  "exactly", "simply", "merely", "mostly", "usually", "generally",
  "normally", "typically", "currently", "recently", "lately", "finally",
  "eventually", "suddenly", "immediately", "completely", "absolutely",
  "particularly", "especially", "specifically", "clearly", "truly",
  "mainly", "nearly", "almost", "fully", "hardly", "barely", "rarely",
  "often", "sometimes",
  // 경동사·조동사·잦은 인지/발화 동사 — 내용이 아니라 문장 골격("let"·"seem"류)
  "let", "lets", "letting", "seem", "seems", "seemed", "seeming",
  "become", "becomes", "became", "becoming", "remain", "remains",
  "appear", "appears", "appeared", "ought", "shall", "must", "able",
  "unable", "used", "ask", "asks", "asked", "asking", "guess", "wonder",
  "believe", "believes", "believed", "suppose", "supposed", "consider",
  "realize", "realized", "remember", "remembers", "remembered", "forget",
  "forgot", "understand", "understood", "explain", "mention", "notice",
  "noticed", "matter", "matters", "care", "cares", "mind",
  // 상시 형용사 + 언어 메타어("word"·"words"도 여기)
  "important", "different", "similar", "possible", "impossible",
  "available", "certain", "various", "several", "single", "whole",
  "entire", "actual", "current", "recent", "final", "simple", "true",
  "false", "full", "empty", "nice", "cool", "fine", "weird", "crazy",
  "funny", "serious", "special", "normal", "usual", "common", "rare",
  "easy", "hard", "difficult", "major", "minor", "main", "word", "words",
  // 시간어·일반명사 — 상시 배경
  "thing", "things", "stuff", "time", "times", "day", "days", "today",
  "tonight", "tomorrow", "yesterday", "week", "weeks", "month", "months",
  "year", "years", "hour", "hours", "minute", "minutes", "second",
  "seconds", "morning", "night", "people", "person", "man", "men",
  "woman", "women", "guy", "guys", "way", "ways", "life", "world",
  // 상용 비속어 — 소셜 텍스트의 상시 배경
  "shit", "fuck", "fucking", "fucked", "damn", "hell", "ass", "bitch",
  // 숫자어
  "zero", "one", "two", "three", "four", "five", "six", "seven", "eight",
  "nine", "ten", "hundred", "thousand", "million", "billion", "third",
  // 인터넷 감탄사·약어·웃음
  "lol", "lmao", "lmfao", "omg", "wtf", "tbh", "idk", "imo", "imho",
  "irl", "smh", "ngl", "btw", "tho", "pls", "plz", "thx", "thanks",
  "thank", "please", "yeah", "yea", "yep", "yes", "nah", "nope", "okay",
  "bruh", "bro", "dude", "haha", "hahaha", "hahahaha", "jaja", "jajaja",
  "jajajaja", "kkk", "kkkk", "kkkkk", "rsrs",
  // 플랫폼 상용어 — 이 데크에서는 항상 존재하는 배경
  "bluesky", "bsky", "post", "posts", "posting", "follow", "followers",
  "following",

  // ── (3) 라틴계 언어 기능어 ──────────────────────────────────────────
  // 포르투갈어 (ES와 공용 철자는 여기 한 번만: que, como, para, por, esta, todo …)
  "que", "nao", "não", "com", "uma", "mas", "mais", "como", "isso",
  "essa", "esse", "isto", "este", "esta", "está", "estao", "estão",
  "estou", "voce", "você", "voces", "vocês", "ele", "ela", "eles",
  "elas", "meu", "minha", "seu", "sua", "tem", "ter", "tinha", "ser",
  "sou", "foi", "era", "sao", "são", "dos", "das", "nas", "nos", "num",
  "numa", "pra", "pro", "para", "por", "muito", "muita", "bem", "entao",
  "então", "quando", "porque", "aqui", "agora", "hoje", "tudo", "todo",
  "toda", "todos", "todas", "gente", "cara", "sim", "nem", "ate", "até",
  "ainda", "coisa", "dia", "ano", "vai", "vou", "fazer", "faz", "fez",
  // 스페인어 (PT와 겹치지 않는 것만)
  "los", "las", "una", "unos", "unas", "del", "pero", "más", "esto",
  "ese", "esa", "eso", "son", "soy", "muy", "bien", "nada", "algo",
  "ahora", "aquí", "hoy", "tengo", "tiene", "tienes", "hay", "sin",
  "cuando", "gracias", "hola", "ella", "ellos", "ellas", "usted",
  "estás", "estan", "están", "tambien", "también", "asi", "así",
  "vamos", "vale",
  // 프랑스어
  "les", "des", "une", "est", "pas", "pour", "avec", "dans", "sur",
  "qui", "quoi", "moi", "toi", "vous", "nous", "ils", "elle", "elles",
  "mon", "mes", "ton", "tes", "ses", "notre", "votre", "tres", "très",
  "tout", "tous", "toute", "toutes", "faire", "fait", "comme", "alors",
  "aussi", "merci", "oui", "non", "plus", "quand", "meme", "même",
  "encore", "deja", "déjà",
  // 독일어 — "war"(be동사 과거)는 영어 "war"를 함께 죽인다: 기능어 유량이
  // 영어 쪽 신호보다 훨씬 크고, 실제 전쟁 뉴스는 국가명·해시태그로 뜬다.
  "und", "der", "die", "das", "den", "dem", "ein", "eine", "einen",
  "einem", "einer", "ist", "sind", "war", "waren", "nicht", "auch",
  "aber", "wenn", "wie", "wer", "wir", "ihr", "sie", "ich", "mich",
  "mir", "mit", "fur", "für", "auf", "aus", "bei", "nur", "noch",
  "schon", "mal", "kein", "keine", "mehr", "sehr", "gut", "dass",
  "muss", "kann", "haben", "habe", "hat", "hatte", "wird", "werden",
  "wurde", "uns", "euch", "dann", "denn", "doch", "heute", "jetzt",
  "immer", "alles", "alle", "oder", "zum", "zur", "vom", "beim",
  "nach", "uber", "über",
  // 이탈리아어
  "che", "per", "della", "delle", "degli", "sono", "anche", "questo",
  "questa", "piu", "più", "perche", "perché", "cosi", "così", "gli",
  "alla", "alle", "nel", "nella", "fatto", "bene", "tutto", "tutti",
  "tutte", "grazie", "ciao", "sempre", "ancora", "essere", "hanno",
  "siamo", "molto", "dove", "quindi",
  // 네덜란드어
  "het", "een", "van", "voor", "met", "dat", "dit", "zijn", "hebben",
  "heeft", "heb", "niet", "maar", "ook", "als", "bij", "naar", "wat",
  "wel", "nog", "heel", "goed", "deze", "dan", "toch", "echt", "gaan",
  "gaat", "doen", "mijn", "ons", "hun", "veel", "meer", "uit", "aan",
  // 인도네시아어
  "yang", "dan", "ini", "itu", "ada", "tidak", "gak", "nggak", "aku",
  "kamu", "dia", "kita", "kami", "mau", "udah", "sudah", "belum",
  "bisa", "aja", "saja", "banget", "kalo", "kalau", "juga", "sama",
  "lagi", "buat", "tapi", "jadi", "gue", "gua", "kan", "dengan",
  "untuk", "karena", "seperti", "masih", "akan", "harus", "orang",
  "hari",
  // 터키어
  "bir", "icin", "için", "ama", "gibi", "cok", "çok", "ben", "sen",
  "biz", "siz", "var", "yok", "bana", "beni", "ile", "daha", "sey",
  "şey", "kadar", "sonra", "simdi", "şimdi", "bugun", "bugün", "evet",
  "hayir", "hayır",
]);
