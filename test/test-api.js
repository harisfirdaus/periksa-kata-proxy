// Test file untuk Periksa Kata API
// Testing basic functionality dan edge cases

import { createRequire } from 'module';
const require = createRequire(import.meta.url);

// Test configuration
const API_URL = process.env.API_URL || 'http://localhost:3000/api/check';
const TEST_TIMEOUT = 30000; // 30 seconds

// Test cases
const testCases = [
  {
    name: 'Valid Indonesian text with typo',
    input: {
      version: '1.0',
      source: {
        kind: 'textarea',
        pageUrl: 'https://example.com',
        language: 'id-ID'
      },
      text: 'Aku ingin makan dubur ayam yang enak sekali.',
      options: {
        categories: ['typo', 'eyd', 'konteks'],
        maxSuggestions: 500
      }
    },
    expectedSuggestions: 1,
    expectedCategory: 'konteks'
  },
  {
    name: 'Text with EYD errors',
    input: {
      version: '1.0',
      source: {
        kind: 'contenteditable',
        pageUrl: 'https://example.com',
        language: 'id-ID'
      },
      text: 'Saya mau ijin untuk pergi ke resiko tinggi.',
      options: {
        categories: ['typo', 'eyd', 'konteks'],
        maxSuggestions: 500
      }
    },
    expectedSuggestions: 2,
    expectedCategory: 'eyd'
  },
  {
    name: 'Clean Indonesian text',
    input: {
      version: '1.0',
      source: {
        kind: 'tiptap',
        pageUrl: 'https://example.com',
        language: 'id-ID'
      },
      text: 'Selamat pagi, semoga hari ini menyenangkan.',
      options: {
        categories: ['typo', 'eyd', 'konteks'],
        maxSuggestions: 500
      }
    },
    expectedSuggestions: 0
  },
  {
    name: 'Empty text',
    input: {
      version: '1.0',
      source: {
        kind: 'textarea',
        pageUrl: 'https://example.com',
        language: 'id-ID'
      },
      text: '',
      options: {
        categories: ['typo', 'eyd', 'konteks'],
        maxSuggestions: 500
      }
    },
    expectError: true,
    expectedStatus: 400
  },
  {
    name: 'Very long text',
    input: {
      version: '1.0',
      source: {
        kind: 'textarea',
        pageUrl: 'https://example.com',
        language: 'id-ID'
      },
      text: 'A'.repeat(15000), // Exceed max length
      options: {
        categories: ['typo', 'eyd', 'konteks'],
        maxSuggestions: 500
      }
    },
    expectError: true,
    expectedStatus: 400
  }
];

// Test runner
class APITester {
  constructor() {
    this.passed = 0;
    this.failed = 0;
    this.total = 0;
  }
  
  async runAllTests() {
    console.log('🚀 Starting Periksa Kata API Tests\n');
    console.log(`Testing API at: ${API_URL}\n`);
    
    for (const testCase of testCases) {
      await this.runTest(testCase);
    }
    
    this.printSummary();
  }
  
  async runTest(testCase) {
    this.total++;
    console.log(`📝 Test ${this.total}: ${testCase.name}`);
    
    try {
      const startTime = Date.now();
      
      const response = await fetch(API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(testCase.input)
      });
      
      const duration = Date.now() - startTime;
      
      if (testCase.expectError) {
        if (response.status === testCase.expectedStatus) {
          console.log(`   ✅ Expected error status ${testCase.expectedStatus} (${duration}ms)`);
          this.passed++;
        } else {
          console.log(`   ❌ Expected status ${testCase.expectedStatus}, got ${response.status}`);
          this.failed++;
        }
        return;
      }
      
      if (!response.ok) {
        const errorText = await response.text();
        console.log(`   ❌ HTTP ${response.status}: ${errorText}`);
        this.failed++;
        return;
      }
      
      const data = await response.json();
      
      // Validate response structure
      if (!this.validateResponse(data)) {
        console.log(`   ❌ Invalid response structure`);
        this.failed++;
        return;
      }
      
      // Check suggestions count
      const suggestionsCount = data.suggestions ? data.suggestions.length : 0;
      if (testCase.expectedSuggestions !== undefined) {
        if (suggestionsCount >= testCase.expectedSuggestions) {
          console.log(`   ✅ Found ${suggestionsCount} suggestions (expected >= ${testCase.expectedSuggestions})`);
        } else {
          console.log(`   ❌ Found ${suggestionsCount} suggestions (expected >= ${testCase.expectedSuggestions})`);
          this.failed++;
          return;
        }
      }
      
      // Check suggestion categories
      if (testCase.expectedCategory && suggestionsCount > 0) {
        const hasExpectedCategory = data.suggestions.some(s => s.category === testCase.expectedCategory);
        if (hasExpectedCategory) {
          console.log(`   ✅ Found expected category: ${testCase.expectedCategory}`);
        } else {
          console.log(`   ❌ Missing expected category: ${testCase.expectedCategory}`);
          this.failed++;
          return;
        }
      }
      
      // Validate suggestion offsets
      if (suggestionsCount > 0) {
        const validOffsets = this.validateOffsets(data.suggestions, testCase.input.text);
        if (validOffsets) {
          console.log(`   ✅ All suggestion offsets are valid`);
        } else {
          console.log(`   ❌ Invalid suggestion offsets`);
          this.failed++;
          return;
        }
      }
      
      console.log(`   ✅ Test passed (${duration}ms)`);
      this.passed++;
      
    } catch (error) {
      console.log(`   ❌ Test failed: ${error.message}`);
      this.failed++;
    }
    
    console.log('');
  }
  
  validateResponse(data) {
    if (!data || typeof data !== 'object') return false;
    if (!data.version || !data.textFingerprint) return false;
    if (!Array.isArray(data.suggestions)) return false;
    
    return true;
  }
  
  validateOffsets(suggestions, originalText) {
    for (const suggestion of suggestions) {
      if (typeof suggestion.start !== 'number' || typeof suggestion.end !== 'number') {
        return false;
      }
      
      if (suggestion.start < 0 || suggestion.end <= suggestion.start) {
        return false;
      }
      
      if (suggestion.end > originalText.length) {
        return false;
      }
      
      // Check if 'before' matches actual text
      const actualText = originalText.slice(suggestion.start, suggestion.end);
      if (actualText !== suggestion.before) {
        console.log(`   ⚠️  Offset mismatch: expected "${suggestion.before}", got "${actualText}"`);
        return false;
      }
    }
    
    return true;
  }
  
  printSummary() {
    console.log('📊 Test Summary');
    console.log('================');
    console.log(`Total tests: ${this.total}`);
    console.log(`Passed: ${this.passed} ✅`);
    console.log(`Failed: ${this.failed} ❌`);
    console.log(`Success rate: ${((this.passed / this.total) * 100).toFixed(1)}%`);
    
    if (this.failed === 0) {
      console.log('\n🎉 All tests passed!');
      process.exit(0);
    } else {
      console.log('\n💥 Some tests failed!');
      process.exit(1);
    }
  }
}

// Performance test
async function performanceTest() {
  console.log('\n⚡ Performance Test');
  console.log('==================');
  
  const testText = 'Ini adalah teks untuk tes performa yang cukup panjang dengan beberapa kesalahan seperti ijin dan resiko.';
  const iterations = 5;
  const times = [];
  
  for (let i = 0; i < iterations; i++) {
    const startTime = Date.now();
    
    try {
      const response = await fetch(API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          version: '1.0',
          source: {
            kind: 'textarea',
            pageUrl: 'https://example.com',
            language: 'id-ID'
          },
          text: testText,
          options: {
            categories: ['typo', 'eyd', 'konteks'],
            maxSuggestions: 500
          }
        })
      });
      
      if (response.ok) {
        await response.json();
      }
      
      const duration = Date.now() - startTime;
      times.push(duration);
      console.log(`Request ${i + 1}: ${duration}ms`);
      
    } catch (error) {
      console.log(`Request ${i + 1}: Failed - ${error.message}`);
    }
  }
  
  if (times.length > 0) {
    const avgTime = times.reduce((a, b) => a + b, 0) / times.length;
    const minTime = Math.min(...times);
    const maxTime = Math.max(...times);
    
    console.log(`\nAverage response time: ${avgTime.toFixed(1)}ms`);
    console.log(`Min response time: ${minTime}ms`);
    console.log(`Max response time: ${maxTime}ms`);
  }
}

// Rate limiting test
async function rateLimitTest() {
  console.log('\n🚦 Rate Limiting Test');
  console.log('=====================');
  
  const requests = [];
  const testText = 'Test rate limiting.';
  
  // Send 15 requests rapidly (should hit rate limit)
  for (let i = 0; i < 15; i++) {
    requests.push(
      fetch(API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          version: '1.0',
          source: {
            kind: 'textarea',
            pageUrl: 'https://example.com',
            language: 'id-ID'
          },
          text: testText,
          options: {
            categories: ['typo', 'eyd', 'konteks'],
            maxSuggestions: 500
          }
        })
      })
    );
  }
  
  try {
    const responses = await Promise.all(requests);
    const statusCodes = responses.map(r => r.status);
    const rateLimited = statusCodes.filter(s => s === 429).length;
    const successful = statusCodes.filter(s => s === 200).length;
    
    console.log(`Successful requests: ${successful}`);
    console.log(`Rate limited requests: ${rateLimited}`);
    
    if (rateLimited > 0) {
      console.log('✅ Rate limiting is working');
    } else {
      console.log('⚠️  Rate limiting may not be working properly');
    }
    
  } catch (error) {
    console.log(`❌ Rate limit test failed: ${error.message}`);
  }
}

// Main execution
async function main() {
  const tester = new APITester();
  
  try {
    await tester.runAllTests();
    await performanceTest();
    await rateLimitTest();
  } catch (error) {
    console.error('Test execution failed:', error);
    process.exit(1);
  }
}

// Run tests
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}

export { APITester, performanceTest, rateLimitTest };