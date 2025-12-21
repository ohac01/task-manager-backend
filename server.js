const express = require('express');
const cors = require('cors');
const { GoogleGenerativeAI } = require("@google/generative-ai");
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);

// In-memory storage for user's custom links (in production, use a database)
const userLinks = [];

// Fuzzy keyword matching function
function findMatchingLinks(taskTitle, userLinks) {
  const taskWords = taskTitle.toLowerCase().split(' ');
  const matches = [];
  
  for (const link of userLinks) {
    const keywords = link.keywords.toLowerCase().split(',').map(k => k.trim());
    
    // Check if any task word matches any keyword
    for (const taskWord of taskWords) {
      for (const keyword of keywords) {
        if (taskWord.includes(keyword) || keyword.includes(taskWord)) {
          matches.push(link);
          break;
        }
      }
      if (matches.includes(link)) break;
    }
  }
  
  return matches;
}

app.post('/api/get-suggestion', async (req, res) => {
  try {
    const { taskTitle, dueDate, priority, userLocation } = req.body;
    
    const matchingLinks = findMatchingLinks(taskTitle, userLinks);
    
    if (matchingLinks.length > 0) {
      const links = matchingLinks.slice(0, 3).map(link => ({
        url: link.url,
        description: link.description,
        source: 'saved'
      }));
      return res.json({ links });
    }
    
    const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });
    
    const locationText = userLocation ? `User location: ${userLocation}` : 'User location: Israel';
    
    const prompt = `For the task "${taskTitle}", provide up to 3 actionable web links that would help complete this task. 

${locationText}

LANGUAGE INSTRUCTION: 
- Detect the language of the task text: "${taskTitle}"
- Write descriptions in THE SAME language as the task
- If task is in Hebrew → Hebrew descriptions and prefer Hebrew/Israeli sites
- If task is in English → English descriptions and international/English sites
- DO NOT assume language based on location - only based on the task text itself

Return ONLY a JSON array with this exact format (no additional text):
[
  {
    "url": "https://example.com",
    "description": "SITE NAME: Brief action (e.g., Zara: Shop online, Renault: Book service)"
  }
]

Rules:
- ALWAYS include the website/company name in the description
- Format: "Site Name: What you can do there"
- Keep descriptions short (max 6-8 words total)
- Match the language of the task text
- Consider the user's location for relevant local options
- Provide direct, actionable links
- If uncertain, provide a Google search link as fallback
- Provide 1-3 links maximum
- Return valid JSON only, no markdown, no additional text`;
    
    const result = await model.generateContent(prompt);
    let responseText = result.response.text().trim();
    
    responseText = responseText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    
    const links = JSON.parse(responseText);
    
    const linksWithSource = links.map(link => ({
      ...link,
      source: 'ai'
    }));
    
    res.json({ links: linksWithSource });
  } catch (error) {
    console.error('Error:', error);
    
    const searchQuery = encodeURIComponent(req.body.taskTitle);
    const fallbackLinks = [{
      url: `https://www.google.com/search?q=${searchQuery}`,
      description: 'Search on Google',
      source: 'fallback'
    }];
    
    res.json({ links: fallbackLinks });
  }
});

// Save a custom link
app.post('/api/save-link', (req, res) => {
  try {
    const { keywords, url, description } = req.body;
    
    if (!keywords || !url || !description) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    
    const newLink = {
      id: Date.now(),
      keywords,
      url,
      description,
      createdAt: new Date().toISOString()
    };
    
    userLinks.push(newLink);
    res.json({ success: true, link: newLink });
  } catch (error) {
    console.error('Error saving link:', error);
    res.status(500).json({ error: 'Failed to save link' });
  }
});

// Get all saved links
app.get('/api/saved-links', (req, res) => {
  res.json({ links: userLinks });
});

// Delete a saved link
app.delete('/api/saved-links/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const index = userLinks.findIndex(link => link.id === id);
  
  if (index !== -1) {
    userLinks.splice(index, 1);
    res.json({ success: true });
  } else {
    res.status(404).json({ error: 'Link not found' });
  }
});

app.post('/api/prioritize-task', async (req, res) => {
  try {
    const { taskTitle, existingTasks, userPriority } = req.body;
    
    const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });
    
    // Create a list of existing task titles for context
    const taskList = existingTasks.map((t, idx) => `${idx + 1}. ${t.title}`).join('\n');
    
    const prompt = `You are helping prioritize a task list. 
    
New task: "${taskTitle}"
${userPriority ? `User specified priority: ${userPriority}` : 'User did not specify priority - use your judgment'}

Existing tasks (in current priority order):
${taskList || 'No existing tasks'}

Return ONLY a single number indicating where this new task should be inserted (1 = highest priority, ${existingTasks.length + 1} = lowest priority).

Consider:
- Urgency (deadlines, time-sensitive matters like bills, appointments)
- Importance (impact on life, health, finances, relationships)
- Dependencies (tasks that block other tasks)
- User's specified priority if provided (but you can override if it seems clearly wrong)

Return ONLY the number, nothing else.`;
    
    const result = await model.generateContent(prompt);
    const responseText = result.response.text().trim();
    const position = parseInt(responseText);
    
    // Validate the position
    if (isNaN(position) || position < 1) {
      return res.json({ position: 1 });
    }
    if (position > existingTasks.length + 1) {
      return res.json({ position: existingTasks.length + 1 });
    }
    
    res.json({ position });
  } catch (error) {
    console.error('Error prioritizing task:', error);
    // Default to end of list on error
    res.json({ position: req.body.existingTasks.length + 1 });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log(`Network: http://192.168.1.127:${PORT}`);
});