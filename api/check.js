// Vercel API endpoint untuk Periksa Kata
// Proxy ke OpenAI GPT-4o mini dengan rate limiting dan validation


// Rate limiting storage (in-memory untuk demo, gunakan Redis untuk production)
const rateLimitStore = new Map();

// Configuration
const CONFIG = {
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  OPENAI_MODEL: 'gpt-4o-mini',
  RATE_LIMIT: {
    maxRequests: 10,
    windowMs: 60000 // 1 menit
  },
  MAX_TEXT_LENGTH: 10000,
  ALLOWED_ORIGINS: [
    'chrome-extension://',
    'moz-extension://',
    'localhost',
    '127.0.0.1'
  ]
};

// LLM System Prompt
const SYSTEM_PROMPT = `Kamu adalah pemeriksa bahasa Indonesia yang ketat: perbaiki **typo**, **ejaan sesuai EYD/PUEBI**, dan **kesalahan konteks** (pilih kata yang benar berdasarkan makna kalimat).
Jawaban **WAJIB** hanya berupa JSON valid mengikuti **Output Schema**. Jangan menulis penjelasan di luar JSON.

Panduan:
* **Kategori**:
  * "typo" untuk salah ketik/kemiripan grafem (aktiviyas→aktivitas).
  * "eyd" untuk kata tidak baku/tidak sesuai EYD (ijin→izin; resiko→risiko).
  * "konteks" untuk kata benar ejaan tetapi salah makna pada kalimat (dubur→bubur).
* **Offsets**: start = index karakter awal, end = index karakter setelah akhir (**exclusive**), dihitung pada **teks mentah** yang diberikan (tanpa HTML).
* Jika ada beberapa kandidat yang wajar, pilih satu "after" terbaik dan tuliskan alasan ringkas pada "message".
* Hindari "membetulkan" gaya bahasa yang sah bila tidak wajib (jangan terlalu agresif).
* Boleh menggabungkan beberapa kata jika itu perbaikan EYD (di lain→di lain? cek konteks; "di dalam" vs "didalam").
* Jaga **maksimal 1 saran per span**; untuk frasa yang panjang boleh satu entri dengan start/end yang mencakup frasa.`;

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
    if (!checkRateLimit(clientId)) {
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
    const suggestions = await checkTextWithOpenAI(text);
    
    // Return response
    const response = {
      version: '1.0',
      textFingerprint,
      suggestions
    };
    
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

// Rate limiting check
function checkRateLimit(clientId) {
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
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex').substring(0, 16);
}

// Call OpenAI API
async function checkTextWithOpenAI(text) {
  const userPrompt = `TASK: Periksa teks bahasa Indonesia untuk typo, ejaan EYD, dan kesalahan konteks. Kembalikan JSON sesuai schema.

INPUT:
<text>
${text}
</text>

SCHEMA:
{
  "version": "1.0",
  "textFingerprint": "<sha256-of-input-text>",
  "suggestions": [
    {
      "id": "string",
      "category": "typo" | "eyd" | "konteks",
      "severity": "low" | "medium" | "high",
      "message": "string (alasan ringkas, bhs Indonesia)",
      "before": "string",
      "after": "string",
      "start": 0,
      "end": 0,
      "confidence": 0.0,
      "examples": ["string"],
      "rules": ["string"]
    }
  ]
}

RESTRICTIONS:
- Hanya JSON, tanpa komentar atau teks lain.
- Offsets wajib tepat terhadap INPUT.`;
  
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
  
  try {
    const parsed = JSON.parse(content);
    
    // Validate and process suggestions
    const suggestions = parsed.suggestions || [];
    const processedSuggestions = [];
    
    for (let i = 0; i < suggestions.length; i++) {
      const suggestion = suggestions[i];
      
      // Validate suggestion structure
      if (!validateSuggestion(suggestion, text)) {
        console.warn('Invalid suggestion skipped:', suggestion);
        continue;
      }
      
      // Add ID if missing
      if (!suggestion.id) {
        suggestion.id = `sg-${Date.now()}-${i}`;
      }
      
      processedSuggestions.push(suggestion);
    }
    
    return processedSuggestions;
    
  } catch (parseError) {
    console.error('Error parsing OpenAI response:', parseError);
    console.error('Raw content:', content);
    throw new Error('Invalid JSON response from OpenAI');
  }
}

// Validate suggestion object
function validateSuggestion(suggestion, originalText) {
  if (!suggestion || typeof suggestion !== 'object') {
    return false;
  }
  
  // Required fields
  const requiredFields = ['category', 'message', 'before', 'after', 'start', 'end'];
  for (const field of requiredFields) {
    if (!(field in suggestion)) {
      console.warn(`Missing required field: ${field}`);
      return false;
    }
  }
  
  // Validate category
  if (!['typo', 'eyd', 'konteks'].includes(suggestion.category)) {
    console.warn('Invalid category:', suggestion.category);
    return false;
  }
  
  // Validate severity
  if (suggestion.severity && !['low', 'medium', 'high'].includes(suggestion.severity)) {
    console.warn('Invalid severity:', suggestion.severity);
    return false;
  }
  
  // Validate positions
  if (typeof suggestion.start !== 'number' || typeof suggestion.end !== 'number') {
    console.warn('Invalid start/end positions');
    return false;
  }
  
  if (suggestion.start < 0 || suggestion.end <= suggestion.start || suggestion.end > originalText.length) {
    console.warn('Invalid position range:', suggestion.start, suggestion.end, originalText.length);
    return false;
  }
  
  // Validate that 'before' matches the text at the specified position
  const actualText = originalText.slice(suggestion.start, suggestion.end);
  if (actualText !== suggestion.before) {
    console.warn('Before text mismatch:', {
      expected: suggestion.before,
      actual: actualText,
      start: suggestion.start,
      end: suggestion.end
    });
    return false;
  }
  
  // Validate confidence
  if (suggestion.confidence !== undefined) {
    if (typeof suggestion.confidence !== 'number' || suggestion.confidence < 0 || suggestion.confidence > 1) {
      console.warn('Invalid confidence value:', suggestion.confidence);
      return false;
    }
  }
  
  return true;
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