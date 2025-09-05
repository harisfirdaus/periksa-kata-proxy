// Vercel API endpoint untuk Periksa Kata
// Proxy ke OpenAI GPT-4o mini dengan rate limiting dan validation

import { createHash } from 'crypto';

// Rate limiting storage (in-memory untuk demo, gunakan Redis untuk production)
const rateLimitStore = new Map();

// Configuration
const CONFIG = {
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  OPENAI_MODEL: 'gpt-4o-mini',
  // Upstash / Vercel KV REST (gunakan token write)
  KV_REST_API_URL: process.env.KV_REST_API_URL,
  KV_REST_API_TOKEN: process.env.KV_REST_API_TOKEN,
  RATE_LIMIT: {
    maxRequests: 10,
    windowMs: 60000 // 1 menit
  },
  MAX_TEXT_LENGTH: 12000,
  ALLOWED_ORIGINS: [
    'chrome-extension://',
    'moz-extension://',
    'localhost',
    '127.0.0.1'
  ]
};

// LLM System Prompt
const SYSTEM_PROMPT = `Kamu adalah pemeriksa bahasa Indonesia yang ahli. Tugas kamu adalah mendeteksi dan memperbaiki kesalahan dalam teks bahasa Indonesia dengan fokus pada 4 kategori utama:

1. **TYPO/SALAH KETIK**: Kesalahan pengetikan seperti huruf hilang, tambahan, atau salah posisi
   - Contoh: "mkn" → "makan", "slh" → "salah", "tdk" → "tidak", "sya" → "saya", "enk" → "enak"
   - Termasuk singkatan tidak standar yang seharusnya ditulis lengkap
   - Prioritaskan kata yang kehilangan huruf vokal atau konsonan penting
   - PENTING: Dalam kalimat "Sya mkn beberapa ayam yang enk sekali" harus mendeteksi 3 kesalahan: "Sya", "mkn", dan "enk"

2. **KATA TIDAK BAKU**: Kata yang tidak sesuai dengan Kamus Besar Bahasa Indonesia (KBBI)
   - Contoh: "ijin" → "izin", "resiko" → "risiko", "aktifitas" → "aktivitas"
   - Kata serapan yang salah ejaan: "system" → "sistem", "methode" → "metode"

3. **KESALAHAN EYD/PUEBI**: Kesalahan penulisan sesuai Ejaan Yang Disempurnakan
   - Penulisan kata depan: "kepasar" → "ke pasar", "dirumah" → "di rumah"
   - Penulisan awalan: "di ambil" → "diambil", "ter buka" → "terbuka"
   - Penulisan partikel: "apa kah" → "apakah", "bagai mana" → "bagaimana"

4. **KESALAHAN KONTEKS**: Kata benar ejaan tapi salah makna dalam kalimat
   - Contoh: "makan dubur ayam" → "makan bubur ayam"
   - Homonim dan kata mirip yang salah konteks

PERINTAH KHUSUS:
- Periksa SETIAP kata dalam teks, jangan lewatkan kesalahan yang mencolok
- WAJIB DETEKSI: Kata seperti "sya", "mkn", "enk", "tdk", "slh" adalah kesalahan PASTI yang harus dideteksi
- Scan SELURUH kalimat: Jangan berhenti setelah menemukan beberapa kesalahan, lanjutkan sampai akhir
- Berikan confidence tinggi (0.8-0.95) untuk kesalahan yang jelas
- Offsets: start = index karakter awal, end = index karakter setelah akhir (exclusive)
- Kategori: "typo", "baku", "eyd", "konteks"
- Severity: "low", "medium", "high"
- JANGAN DUPLIKASI: Setiap kata yang salah hanya boleh muncul SEKALI dalam suggestions
- BATASI JUMLAH: Maksimal 20 saran per respons untuk menghindari JSON terpotong
- JANGAN koreksi huruf kapital pada awal kalimat
- JANGAN mengubah kapitalisasi nama orang/tempat/lembaga, akronim/brand, dan format tanggal yang benar
- HANYA kembalikan saran jika nilai 'before' benar-benar muncul persis (exact substring, case sensitive) di dalam teks segmen yang diberikan. Jika tidak ada, JANGAN keluarkan saran tersebut

FORMAT OUTPUT JSON:
{
  "suggestions": [
    {
      "start": 0,
      "end": 3,
      "category": "typo",
      "severity": "high",
      "message": "Kata 'sya' seharusnya 'saya'",
      "before": "sya",
      "after": "saya"
    }
  ]
}

- Jangan menulis penjelasan di luar JSON
- WAJIB gunakan format JSON di atas dengan field: start, end, category, severity, message, before, after`;

// Main handler
export default async function handler(req, res) {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return res.status(200).json({ ok: true });
  }
  
  // Only allow POST
  if (req.method !== 'POST') {
    return res.status(405).json({ 
      error: 'Method not allowed',
      message: 'Only POST method is supported'
    });
  }
  
  try {
    // Validate API key
    if (!CONFIG.OPENAI_API_KEY) {
      console.error('OpenAI API key not configured');
      return res.status(500).json({
        error: 'Service configuration error',
        message: 'API key not configured'
      });
    }
    
    // Rate limiting
    const clientId = getClientId(req);
    if (!(await checkRateLimit(clientId))) {
      return res.status(429).json({
        error: 'Rate limit exceeded',
        message: 'Terlalu banyak permintaan. Silakan coba lagi nanti.'
      });
    }
    
    // Validate origin (optional)
    const origin = req.headers.origin || req.headers.referer || '';
    if (!isAllowedOrigin(origin)) {
      console.warn('Request from unauthorized origin:', origin);
      // Don't block for now, just log
    }
    
    // Parse and validate request
    const requestData = req.body;
    const validation = validateRequest(requestData);
    if (!validation.isValid) {
      return res.status(400).json({
        error: 'Invalid request',
        message: validation.error
      });
    }
    
    const { text } = requestData;
    
    // Create text fingerprint
    const textFingerprint = createTextFingerprint(text);
    
    // Call OpenAI API
    console.log('Calling OpenAI API with text:', text.substring(0, 100) + '...');
    console.log('Text length:', text.length, 'characters');
    
    let didCallLLM = false;
    let skippedReason = null;
    let suggestions = [];
    
    try {
      didCallLLM = true;
      suggestions = await checkTextWithOpenAI(text);
      console.log('OpenAI API returned suggestions:', suggestions.length);
      
      if (suggestions.length === 0) {
        console.log('OpenAI returned empty suggestions for text:', JSON.stringify(text));
      } else {
        console.log('OpenAI suggestions:', JSON.stringify(suggestions, null, 2));
      }
    } catch (error) {
      console.error('OpenAI API call failed:', error);
      didCallLLM = false;
      skippedReason = 'api_error';
      suggestions = [];
    }
    
    // Return response with meta debug info
    const response = {
      version: '1.0',
      textFingerprint,
      suggestions,
      meta: {
        llmCalled: didCallLLM,
        skippedReason,
        modelUsed: CONFIG.OPENAI_MODEL,
        textLength: text.length,
        suggestionsCount: suggestions.length
      }
    };
    
    console.log('Sending response:', JSON.stringify(response, null, 2));
    return res.status(200).json(response);
    
  } catch (error) {
    console.error('Error in check API:', error);
    
    // Don't expose internal errors
    return res.status(500).json({
      error: 'Internal server error',
      message: 'Terjadi kesalahan saat memproses permintaan'
    });
  }
}

// Rate limiting check (delegator)
async function checkRateLimit(clientId) {
  // Jika konfigurasi Upstash tersedia, gunakan Upstash terlebih dahulu
  if (CONFIG.KV_REST_API_URL && CONFIG.KV_REST_API_TOKEN) {
    try {
      return await checkRateLimitUpstash(clientId);
    } catch (err) {
      console.warn('Rate limit via Upstash gagal, fallback ke in-memory:', err?.message || err);
      // lanjut fallback
    }
  }
  // Fallback ke in-memory agar tidak mengganggu fungsi lain
  return checkRateLimitInMemory(clientId);
}

// Implementasi rate limit via Upstash Redis REST (fixed window + TTL)
async function checkRateLimitUpstash(clientId) {
  const ttlSec = Math.ceil(CONFIG.RATE_LIMIT.windowMs / 1000);
  const key = `periksakata:rl:${clientId}`;

  const url = `${CONFIG.KV_REST_API_URL.replace(/\/$/, '')}/pipeline`;
  const commands = [
    ["INCR", key],
    ["EXPIRE", key, ttlSec, "NX"] // set expiry hanya jika belum ada
  ];

  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${CONFIG.KV_REST_API_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(commands)
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`Upstash REST error: ${resp.status} ${text}`);
  }

  const results = await resp.json();
  // results contoh: [{result: 1}, {result: 1}]
  const incr = Number(results?.[0]?.result ?? 0);
  if (!Number.isFinite(incr)) {
    throw new Error('Invalid INCR result from Upstash');
  }
  return incr <= CONFIG.RATE_LIMIT.maxRequests;
}

// Rate limiting check - in-memory (fallback)
function checkRateLimitInMemory(clientId) {
  const now = Date.now();
  const requests = rateLimitStore.get(clientId) || [];
  
  // Remove old requests
  const validRequests = requests.filter(time => now - time < CONFIG.RATE_LIMIT.windowMs);
  
  if (validRequests.length >= CONFIG.RATE_LIMIT.maxRequests) {
    return false;
  }
  
  validRequests.push(now);
  rateLimitStore.set(clientId, validRequests);
  
  return true;
}

// Get client identifier
function getClientId(req) {
  // Use IP address as client identifier
  const forwarded = req.headers['x-forwarded-for'];
  const ip = forwarded ? forwarded.split(',')[0] : req.connection.remoteAddress;
  return ip || 'unknown';
}

// Check if origin is allowed
function isAllowedOrigin(origin) {
  if (!origin) return true; // Allow requests without origin
  
  return CONFIG.ALLOWED_ORIGINS.some(allowed => {
    if (allowed.endsWith('://')) {
      return origin.startsWith(allowed);
    }
    return origin.includes(allowed);
  });
}

// Validate request data
function validateRequest(data) {
  if (!data) {
    return { isValid: false, error: 'Request body is required' };
  }
  
  if (!data.text || typeof data.text !== 'string') {
    return { isValid: false, error: 'Text field is required and must be a string' };
  }
  
  if (data.text.length === 0) {
    return { isValid: false, error: 'Text cannot be empty' };
  }
  
  if (data.text.length > CONFIG.MAX_TEXT_LENGTH) {
    return { 
      isValid: false, 
      error: `Text too long. Maximum ${CONFIG.MAX_TEXT_LENGTH} characters allowed` 
    };
  }
  
  // Validate version
  if (data.version && data.version !== '1.0') {
    return { isValid: false, error: 'Unsupported API version' };
  }
  
  return { isValid: true };
}

// Create text fingerprint
function createTextFingerprint(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex').substring(0, 16);
}

// Utility: cari kemunculan "needle" paling dekat dengan approxIndex (jika disediakan)
function findNearestIndex(haystack, needle, approxIndex) {
  if (!needle || needle.length === 0) return -1;
  const occurrences = [];
  let from = 0;
  while (true) {
    const idx = haystack.indexOf(needle, from);
    if (idx === -1) break;
    occurrences.push(idx);
    from = idx + 1;
  }
  if (occurrences.length === 0) return -1;
  if (approxIndex == null || Number.isNaN(approxIndex)) return occurrences[0];
  let best = occurrences[0];
  let bestDist = Math.abs(best - approxIndex);
  for (let i = 1; i < occurrences.length; i++) {
    const d = Math.abs(occurrences[i] - approxIndex);
    if (d < bestDist) {
      best = occurrences[i];
      bestDist = d;
    }
  }
  return best;
}

// Utility: case-insensitive search dengan pengembalian indeks akurat di haystack asli
function findNearestIndexCI(haystack, needle, approxIndex) {
  const hayLower = haystack.toLowerCase();
  const needLower = (needle || '').toLowerCase();
  if (!needLower) return -1;
  const occurrences = [];
  let from = 0;
  while (true) {
    const idx = hayLower.indexOf(needLower, from);
    if (idx === -1) break;
    occurrences.push(idx);
    from = idx + 1;
  }
  if (occurrences.length === 0) return -1;
  if (approxIndex == null || Number.isNaN(approxIndex)) return occurrences[0];
  let best = occurrences[0];
  let bestDist = Math.abs(best - approxIndex);
  for (let i = 1; i < occurrences.length; i++) {
    const d = Math.abs(occurrences[i] - approxIndex);
    if (d < bestDist) {
      best = occurrences[i];
      bestDist = d;
    }
  }
  return best;
}

// Call OpenAI API
async function checkTextWithOpenAI(text) {
  const userPrompt = `Periksa teks berikut dan temukan SEMUA kesalahan ejaan, typo, EYD, dan konteks:

"${text}"

Cari dengan teliti:
✓ Typo/singkatan: huruf hilang, singkatan tidak standar
✓ Kata tidak baku: kata yang tidak ada di KBBI
✓ EYD: penulisan kata depan, awalan, akhiran
✓ Konteks: kata benar ejaan tapi salah makna

ATURAN PENTING:
- JANGAN DUPLIKASI: Setiap kata yang salah hanya boleh muncul SEKALI
- MAKSIMAL 20 saran untuk menghindari respons terpotong
- Prioritaskan kesalahan yang paling mencolok
- JANGAN koreksi huruf kapital pada awal kalimat
- JANGAN mengubah kapitalisasi nama orang/tempat/lembaga, akronim/brand, dan format tanggal yang benar
- HANYA kembalikan saran jika nilai 'before' benar-benar muncul persis (exact substring, case sensitive) di dalam teks segmen yang diberikan. Jika tidak ada, JANGAN keluarkan saran tersebut

PENTING - PENGHITUNGAN OFFSET:
- Hitung posisi karakter dengan SANGAT TELITI
- start = index karakter pertama dari kata yang salah
- end = index karakter setelah kata yang salah (exclusive)
- Field 'before' HARUS sama persis dengan teks di posisi start-end (CASE SENSITIVE)
- Pertahankan kapitalisasi asli: jika teks asli 'Sya' maka before: 'Sya', bukan 'sya'
- Jangan sertakan spasi di awal/akhir kecuali memang bagian dari kesalahan

Contoh untuk "Ini adalah demnstrasi":
- Kata "demnstrasi" dimulai di index 11, berakhir di index 21
- before: "demnstrasi" (tanpa spasi)
- after: "demonstrasi"

Contoh untuk "Sya mkn ayam":
- Kata "Sya" dimulai di index 0, berakhir di index 3
- before: "Sya" (dengan huruf besar S, sesuai teks asli)
- after: "Saya"

Contoh untuk "Makanan ini enk sekali":
- Kata "enk" dimulai di index 12, berakhir di index 15
- before: "enk" (kata singkatan tidak baku)
- after: "enak"

Kembalikan JSON dengan format yang tepat dan offset yang AKURAT.`;
  
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${CONFIG.OPENAI_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: CONFIG.OPENAI_MODEL,
      messages: [
        {
          role: 'system',
          content: SYSTEM_PROMPT
        },
        {
          role: 'user',
          content: userPrompt
        }
      ],
      temperature: 0.1,
      max_tokens: 2000,
      response_format: { type: 'json_object' }
    })
  });
  
  if (!response.ok) {
    const errorData = await response.text();
    console.error('OpenAI API error:', response.status, errorData);
    throw new Error(`OpenAI API error: ${response.status}`);
  }
  
  const data = await response.json();
  
  if (!data.choices || data.choices.length === 0) {
    throw new Error('No response from OpenAI API');
  }
  
  const content = data.choices[0].message.content;
  
  // Parse with repair and strict-retry fallback
  let parsed;
  try {
    parsed = tryParseJSONWithRepair(content);
  } catch (parseErr) {
    console.warn('Primary JSON parse failed, attempting strict retry...', parseErr?.message || parseErr);
    const retryRaw = await strictRetryJSON(text);
    if (!retryRaw) {
      console.error('Strict retry returned empty content');
      return [];
    }
    try {
      parsed = tryParseJSONWithRepair(retryRaw);
    } catch (retryErr) {
      console.error('Strict retry JSON parse failed:', retryErr?.message || retryErr);
      console.error('Raw content (primary):', content);
      console.error('Raw content (retry):', retryRaw);
      return [];
    }
  }

  // Validate and process suggestions
  const suggestions = Array.isArray(parsed?.suggestions) ? parsed.suggestions : [];
  const processedSuggestions = [];

  // Untuk mencegah duplikasi/overlap
  const takenRanges = [];
  const overlaps = (s, e) => takenRanges.some(([ts, te]) => !(e <= ts || s >= te));

  for (let i = 0; i < suggestions.length; i++) {
    const suggestion = suggestions[i];
    
    // Cek struktur minimum
    if (!basicSuggestionShapeValid(suggestion)) {
      console.warn('Missing required field(s) on suggestion:', suggestion);
      continue;
    }

    // Validasi kategori/severity awal
    if (!['typo', 'baku', 'eyd', 'konteks'].includes(suggestion.category)) {
      console.warn('Invalid category:', suggestion.category);
      continue;
    }
    if (suggestion.severity && !['low', 'medium', 'high'].includes(suggestion.severity)) {
      console.warn('Invalid severity:', suggestion.severity);
      continue;
    }

    let { start, end, before } = suggestion;
    // Jaga batas
    if (typeof start !== 'number') start = 0;
    if (typeof end !== 'number') end = Math.min(text.length, (start || 0) + String(before || '').length);
    start = Math.max(0, Math.min(start, text.length));
    end = Math.max(start, Math.min(end, text.length));

    let actualText = text.slice(start, end);
    if (actualText !== before) {
      // Coba koreksi: cari kemunculan before terdekat
      const idxExact = findNearestIndex(text, before, start);
      if (idxExact !== -1) {
        const newStart = idxExact;
        const newEnd = idxExact + String(before || '').length;
        console.warn('Adjusted offsets (exact match) from', { start, end }, 'to', { start: newStart, end: newEnd });
        start = newStart;
        end = newEnd;
        actualText = text.slice(start, end);
      } else {
        // Coba case-insensitive dan set before ke teks asli
        const idxCI = findNearestIndexCI(text, before, start);
        if (idxCI !== -1) {
          const newStart = idxCI;
          const newEnd = idxCI + String(before || '').length;
          const actual = text.slice(newStart, newEnd);
          console.warn('Adjusted offsets (case-insensitive) from', { start, end }, 'to', { start: newStart, end: newEnd }, 'and normalized before to actual substring');
          start = newStart;
          end = newEnd;
          before = actual; // samakan dengan teks asli agar konsumen downstream cocok
          actualText = actual;
        } else {
          console.warn('Before text mismatch and could not auto-correct:', {
            expected: before,
            actual: actualText,
            start,
            end
          });
          continue; // skip jika benar-benar tidak dapat dipetakan
        }
      }
    }

    // Hindari overlap/duplikasi
    if (overlaps(start, end)) {
      console.warn('Overlapping suggestion skipped:', { start, end, before });
      continue;
    }

    // Sanitasi field string untuk menghindari karakter tidak valid/bermasalah
    const sanitizedMessage = sanitizeString(String(suggestion.message), 200);
    let afterVal = typeof suggestion.after === 'string' ? suggestion.after : String(suggestion.after ?? '');
    afterVal = sanitizeString(afterVal, 100);

    const fixed = {
      ...suggestion,
      start,
      end,
      before: actualText, // pakai substring asli untuk memastikan kecocokan
      after: afterVal,
      message: sanitizedMessage,
    };

    // Tambahkan ID jika belum ada
    if (!fixed.id) {
      fixed.id = `sg-${Date.now()}-${i}`;
    }

    takenRanges.push([start, end]);
    processedSuggestions.push(fixed);

    // Batasi maksimal 20 untuk keamanan
    if (processedSuggestions.length >= 20) break;
  }
  
  return processedSuggestions;
}

// Validasi bentuk minimum suggestion (tanpa verifikasi posisi yang ketat dulu)
function basicSuggestionShapeValid(suggestion) {
  if (!suggestion || typeof suggestion !== 'object') return false;
  const requiredFields = ['category', 'message', 'before', 'after', 'start', 'end'];
  for (const field of requiredFields) {
    if (!(field in suggestion)) return false;
  }
  return true;
}

// Parsing helper dengan "JSON repair" ringan
function tryParseJSONWithRepair(content) {
  // Coba parse langsung
  try {
    return JSON.parse(content);
  } catch (_) {
    // Lanjut ke perbaikan ringan
  }
  
  const block = extractJSONBlock(content);
  if (block) {
    return JSON.parse(block);
  }
  
  // Gagal total
  throw new Error('Unable to parse JSON (even after repair)');
}

// Ekstrak blok JSON terluar dengan pencocokan kurung kurawal
function extractJSONBlock(str) {
  if (!str) return null;
  const start = str.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  for (let i = start; i < str.length; i++) {
    const ch = str[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        return str.slice(start, i + 1);
      }
    }
  }
  return null;
}

// Retry ketat untuk meminta JSON valid saja
async function strictRetryJSON(text) {
  try {
    const strictResponse = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${CONFIG.OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: CONFIG.OPENAI_MODEL,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: `${text}\n\nPENTING: Keluarkan JSON VALID SAJA sesuai skema (tanpa teks lain). Jika ragu, kembalikan {\"suggestions\": []}.` }
        ],
        temperature: 0,
        max_tokens: 2000,
        response_format: { type: 'json_object' }
      })
    });
    if (!strictResponse.ok) {
      const err = await strictResponse.text();
      console.error('Strict retry API error:', strictResponse.status, err);
      return null;
    }
    const data = await strictResponse.json();
    const content = data?.choices?.[0]?.message?.content;
    return content || null;
  } catch (e) {
    console.error('Strict retry request failed:', e);
    return null;
  }
}

// Sanitasi string: hapus karakter kontrol, trimming, dan batasi panjang
function sanitizeString(input, maxLen) {
  try {
    let s = String(input ?? '');
    // Hapus karakter kontrol non-whitespace standar
    s = s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ');
    s = s.replace(/\s+/g, ' ').trim();
    if (typeof maxLen === 'number' && maxLen > 0 && s.length > maxLen) {
      s = s.slice(0, maxLen);
    }
    return s;
  } catch {
    return '';
  }
}

// Cleanup old rate limit entries periodically
setInterval(() => {
  const now = Date.now();
  for (const [clientId, requests] of rateLimitStore.entries()) {
    const validRequests = requests.filter(time => now - time < CONFIG.RATE_LIMIT.windowMs);
    if (validRequests.length === 0) {
      rateLimitStore.delete(clientId);
    } else {
      rateLimitStore.set(clientId, validRequests);
    }
  }
}, CONFIG.RATE_LIMIT.windowMs);