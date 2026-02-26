# LLM-Powered Search Integration Guide

## Overview

Stepper 3.0 includes optional AI-powered search that uses a Large Language Model (LLM) to intelligently rerank search results based on user queries. This feature enhances the basic keyword search by understanding context and intent.

## How It Works

### Search Flow

1. **Keyword Search (Always)**: The system first performs a traditional keyword-based search with relevance scoring:
   - Title matches: 10+ points (highest priority)
   - Tag matches: 5+ points
   - Summary matches: 4+ points
   - Step content matches: 1-3 points
   - Tokenized query matching for multi-word searches

2. **LLM Reranking (Optional)**: If enabled and configured, the system:
   - Takes the top 20 keyword results
   - Sends article metadata (title, summary, tags) to the LLM
   - Asks the LLM to rank articles by relevance to the user query
   - Merges LLM rankings with keyword scores
   - Returns top 10 results

3. **Graceful Fallback**: If LLM search fails (timeout, API error, etc.), the system automatically falls back to keyword-only results.

## Configuration

### Settings Required

To enable LLM search, configure these settings in the options page (⚙️ button):

1. **Enable LLM-Powered Search**: Check this box to activate the feature
2. **LLM Endpoint**: The API endpoint URL (e.g., `https://api.openai.com/v1/chat/completions`)
3. **API Key**: Your authentication key for the LLM service

### Supported LLM Services

The implementation is designed to work with OpenAI-compatible APIs:

- **OpenAI**: `https://api.openai.com/v1/chat/completions`
- **Azure OpenAI**: `https://<your-resource>.openai.azure.com/openai/deployments/<deployment-name>/chat/completions?api-version=2023-05-15`
- **Other OpenAI-compatible services**: Any service that accepts the same request/response format

## API Request Format

The extension sends a POST request to the configured endpoint:

```json
{
  "model": "gpt-3.5-turbo",
  "messages": [
    {
      "role": "user",
      "content": "You are a helpful assistant...\n\nUser query: \"password reset\"\n\nAvailable articles: [{...}]\n\nTask: Select and rank..."
    }
  ],
  "temperature": 0.3,
  "max_tokens": 500
}
```

Headers:
```
Content-Type: application/json
Authorization: Bearer <your-api-key>
```

## Timeout and Error Handling

- **Timeout**: 10 seconds maximum per LLM request
- **On Timeout**: Gracefully falls back to keyword search results
- **On Error**: Falls back to keyword search results with error logged to console
- **No Retry**: To avoid delays, failed LLM calls are not retried

## Security Considerations

1. **API Key Storage**: Keys are stored in chrome.storage.local (not visible in logs)
2. **Data Privacy**: Only article metadata (title, summary, tags) is sent to LLM, not full step content
3. **No User Data**: User queries are sent to LLM but no personal information
4. **HTTPS Only**: All API calls must use HTTPS

## Performance

- **Keyword Search**: ~5-10ms (instant)
- **LLM Search**: 500-3000ms (depends on API latency)
- **Total**: Max 10 seconds (with timeout)

Users see keyword results immediately if LLM is slow or fails.

## Testing the Feature

### 1. Without LLM (Default)
1. Open the extension popup
2. Enter a search query: "password reset"
3. Press Enter
4. See keyword-ranked results instantly

### 2. With LLM Enabled
1. Click ⚙️ to open settings
2. Check "Enable LLM-Powered Search"
3. Enter LLM Endpoint: `https://api.openai.com/v1/chat/completions`
4. Enter your OpenAI API Key
5. Save settings
6. Open popup and search: "I need to help a user reset their password"
7. LLM will understand the intent and rank password-related articles higher

## Debugging

Check browser console for logs:
- `Searching for: <query>` - Search initiated
- `LLM search failed, falling back to keyword search:` - LLM error (with details)
- Keyword search always logs results count

## Cost Considerations

- Each search with LLM enabled costs 1 API call
- Typical cost: ~$0.001-0.002 per search (GPT-3.5-turbo)
- Consider usage limits and quotas for your API key
- Keyword-only search is completely free

## Example Use Cases

### Best for LLM Search:
- Natural language queries: "How do I fix a printer that won't print?"
- Vague descriptions: "User can't access files"
- Complex intent: "Employee needs VPN setup for remote work"

### Keyword Search is Sufficient for:
- Exact matches: "password reset"
- Tag searches: "vpn"
- Title searches: "printer installation"

## Limitations

1. LLM only sees article metadata (not full step content)
2. Max 20 articles sent to LLM (top keyword results)
3. Returns max 10 results total
4. Requires internet connection to LLM service
5. Subject to LLM service rate limits and quotas

## Future Enhancements

- [ ] Support for multiple LLM providers
- [ ] Caching of LLM responses for common queries
- [ ] User feedback on result relevance
- [ ] Progressive result display (show keyword results while waiting for LLM)
- [ ] A/B testing to measure LLM effectiveness
