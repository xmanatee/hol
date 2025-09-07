# OpenAI Integration Setup for Phase 10 Personality Generation

## Quick Setup

1. **Get OpenAI API Key**
   - Go to https://platform.openai.com/api-keys
   - Create a new API key

2. **Set Environment Variable**
   ```bash
   # Create .env file in project root
   echo "VITE_OPENAI_API_KEY=your_api_key_here" > .env
   ```

3. **Start Development Server**
   ```bash
   npm run dev
   ```

## How to Use

1. **Start Camera**: Click "Start Camera" to access rear camera
2. **Select Object**: Tap on a bottle, can, or cup to track it
3. **Generate Personality**: Open Control Panel → Personality → "Generate Personality"
4. **View Results**: Personality details appear in the control panel

## Expected API Costs

- **Vision API**: ~$0.01 per personality generation (1 image analysis)
- **Chat API**: ~$0.002 per personality generation (1 chat completion)
- **Total**: ~$0.012 per personality generation

## API Models Used

- **Vision**: `gpt-4-vision-preview` for object description
- **Chat**: `gpt-4` for personality generation  
- **Parameters**: 300 max tokens, temperature 0.8

## Customization

Override models/settings in environment:

```bash
VITE_OPENAI_VISION_MODEL=gpt-4-vision-preview
VITE_OPENAI_CHAT_MODEL=gpt-4
VITE_OPENAI_MAX_TOKENS=300
VITE_OPENAI_TEMPERATURE=0.8
```

## Troubleshooting

**"API key not configured"**
- Check .env file exists and has correct VITE_OPENAI_API_KEY
- Restart development server after adding .env

**"Rate limit exceeded"**  
- You've hit OpenAI's rate limits, wait and try again
- Consider upgrading OpenAI plan for higher limits

**"Network error"**
- Check internet connection
- Verify OpenAI services are operational

## Security Note

API keys are visible in frontend code. For production:
- Use environment-specific keys
- Monitor usage to prevent abuse
- Consider implementing usage limits