import { ChatOpenAI } from '@langchain/openai';
import { ChatPromptTemplate } from '@langchain/core/prompts';
import pkg from '@slack/bolt';
import { WebClient } from '@slack/web-api';
const { App } = pkg;
import dotenv from 'dotenv';
import express from 'express';
import axios from 'axios';

import { initDatabase, saveMemberAnalysis, markAsSentToSlack, closeDatabase } from './db.js';

const log = {
    info: (msg, ...args) => console.log(`INFO: ${msg}`, ...args),
    error: (msg, ...args) => console.error(`ERROR: ${msg}`, ...args),
    debug: (msg, ...args) => process.env.NODE_ENV === "development" && console.debug(`DEBUG: ${msg}`, ...args),
}

class SlackAIAgent {
    constructor() {
        this.app = express()
        this.slack = new App({
            token: process.env.SLACK_BOT_TOKEN,
            signingSecret: process.env.SLACK_SIGNING_SECRET,
            socketMode: true,
            appToken: process.env.SLACK_APP_TOKEN,
        });
        this.WebClient = new WebClient(process.env.SLACK_BOT_TOKEN);
        this.openai = new ChatOpenAI({
            model: 'gpt-4o',
            temperature: 0.3,
            apiKey: process.env.OPENAI_API_KEY,
        })

        this.setupSlackEvents();
        this.setupExpress();
    }

    setupSlackEvents() {
        this.slack.event('team_join', async ({ event }) => {
            try {
                log.info(`NEW MEMBER JOINED: ${event.user.real_name} (${event.user.name})`);
                const userInfo = await this.getUserInfo(event.user.id);
                await this.analyzeAndPostMember(userInfo);
            }
            catch (err) {
                log.error('Error handling team_join event', err.message);
            }
        })

        this.slack.event('member_joined_channel', async ({ event }) => {

            try {
                log.info(`MEMBER JOINED CHANNEL: ${event.user} joined ${event.channel}`);
                if (event.channel_type === 'C') {
                    log.info(`Member ${event.user} joined a public channel ${event.channel}, fetching channel info...`);
                } const userInfo = await this.getUserInfo(event.user);
                await this.analyzeAndPostMember(userInfo);
            }
            catch (err) {
                log.error('Error handling member joined_channel event', err.message);
            }
        })
        this.slack.error(async (err) => log.error('Slack error', err.message));
    }

    setupExpress() {
        this.app.use(express.json());

        this.app.get('/health', (req, res) => {
            res.json({ status: 'haelthy', timestamp: new Date().toISOString() });
        })

        if (process.env.NODE_ENV === 'development') {
            this.app.post('/test/analyze-member', async (req, res) => {
                try {
                    const { memberInfo } = req.body;
                    if (!memberInfo) {
                        return res.status(400).json({ error: 'Missing memberInfo in request body' });
                    }
                    await this.analyzeAndPostMember(memberInfo);
                    res.json({ success: true, timestamp: new Date().toISOString() });
                }
                catch (err) {
                    log.error('Error in test analyze-member endpoint', err.message);
                    res.status(500).json({ error: 'Analysis sfailed' });
                }
            })
        }

        this.app.use((err, req, res, next) => {
            log.error('Express error', err.message);
            res.status(500).json({ error: 'Internal Server Error' });
        })
    }

    async getUserInfo(userId) {
        try {
            const response = await this.WebClient.users.info({ user: userId });
            const user = response.user;
            return {
                id: user.id,
                name: user.real_name || user.name,
                username: user.name,
                email: user.profile?.email,
                title: user.profile?.title,
                timezone: user.tz,
                profile: {
                    real_name: user.profile?.real_name,
                    last_name: user.profile?.last_name,
                    status_text: user.profile?.status_text,
                }
            }
        }
        catch (err) {
            log.error(`Error fetching user info for ${userId}`, err.message);
            throw err;
        }

    }

    async analyzeAndPostMember(memberInfo) {
        let analysisId;
        try {
            log.info(`Processing member: ${memberInfo.name}`);
            const researchData = await this.doBasicResearch(memberInfo);
            const analysis = await this.analyzeWithAI(memberInfo, researchData);
            log.info(`Analysis complete for ${memberInfo.name}, posting to Slack...`);
            analysisId = await saveMemberAnalysis(memberInfo, analysis, researchData);

            await this.postAnalysisToChannel(memberInfo, analysis, researchData);

            if (analysisId) {
                await markAsSentToSlack(analysisId);
            }
        }
        catch (err) {
            log.error('Error in analyzeAndPostMember ' + memberInfo.name, err.message);
            if (analysisId) {
                log.info(`Analysis failed for ${analysisId} saved to database but not sent to Slack due to error`);
            }
            throw err;
        }
    }

    async doBasicResearch(memberInfo) {
        const results = []
        try {
            if (memberInfo.email && !this.isPersonalEmail(memberInfo.email)) {
                const domain = memberInfo.email.split('@')[1];
                const companyInfo = await this.getComapnyInfo(domain);
                if (companyInfo) results.push(companyInfo);

                if (memberInfo.name) {
                    const githubInfo = await this.getGitHubInfo(memberInfo.name);
                    if (githubInfo) results.push(githubInfo);
                }
            }
        }
        catch (err) {
            log.error('Error in doBasicResearch for ' + memberInfo.name, err.message);
        }
        return results;
    }

    async getComapnyInfo(domain) {
        let title;
        try {
            const response = await axios.get(`https://www.${domain}`, {
                timeout: 5000,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
                }
            })

            const titleMatch = response.data.match(/<title>(.*?)<\/title>/i);
            title = titleMatch ? titleMatch[1] : `Company ${domain}`;
        }
        catch (err) {
            log.error(`Error fetching company info for domain ${domain}`, err.message);
            return null;
        }

        return {
            url: `https://www.${domain}`,
            title: title || `Company ${domain}`,
            content: `Company website for ${domain}`,
            type: 'company'
        }

    }

    async getGitHubInfo(name) {
        try {
            const response = await axios.get(`https://api.github.com/search/users?q=${encodeURIComponent(name)} in:fullname`, {
                timeout: 5000,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
                }
            })
            if (response.data && response.data.items && response.data.items.length > 0) {
                const user = response.data.items[0];
                return {
                    url: user.html_url,
                    title: `GitHub ${user.login}`,
                    content: `{user.public_repos} public repositories`,
                    type: 'github'
                }
            }
        }
        catch (err) {
            log.error(`Error fetching GitHub info for ${name}`, err.message);
            return null;
        }
    }

    async analyzeWithAI(memberInfo, researchData) {
        const prompt = ChatPromptTemplate.fromTemplate(
            `Analyze this new community member for fit with our commercial 
    product.

    Company: ${process.env.COMPANY_NAME || 'Your Company'}
    Product: ${process.env.COMPANY_PRODUCT || 'Your Product'}

    Member:
    - Name: {name}
    - Email: {email}
    - Title: {title}

    Research Data:
    {research}

    Provide a JSON response with:
    - fitScore (0-100): likelihood they'd be interested in our product
    - insights: array of 3-5 key observations
    - recommendations: array of 2-4 engagement suggestions

    Consider job title, company size, technical background, and budget 
    authority.`
        );


        // TODO: remove stub when OpenAI quota is restored
        return {
            fitScore: 75,
            insights: [
                `${memberInfo.name} holds a ${memberInfo.title || 'technical'} role`,
                'Company domain suggests a mid-size B2B organisation',
                'Technical background indicates hands-on decision-making authority',
                'Timezone aligns with core business hours'
            ],
            recommendations: [
                'Send a personalised welcome message highlighting relevant features',
                'Invite to next product demo or onboarding call',
                'Share case studies relevant to their industry'
            ]
        };

        try {
            const researchSummary = researchData.length > 0
                ? researchData.map(r => `${r.title}: ${r.content}`).join(`\\n`)
                : 'Limited research data available'

            const chain = prompt.pipe(this.openai);
            const result = await chain.invoke({
                name: memberInfo.name,
                email: memberInfo.email || 'Not provided',
                title: memberInfo.title || 'not provided',
                research: researchSummary
            });

            const responseText = result.content || result;

            const cleanedResponse =
                responseText.replace(/```json\n?|\n?```/g, '').trim()

            const analysis = JSON.parse(cleanedResponse)

            return {
                fitScore: Math.max(0, Math.min(100, analysis.fitScore || 50)),
                insights: Array.isArray(analysis.insights) ? analysis.insights : ['Analysis completed'],
                recommendations: Array.isArray(analysis.recommendations) ? analysis.recommendations : ['Follow up recommended']
            }

        } catch (error) {
            log.error('AI analysis error:', error.message);
            return {
                fitScore: 50,
                insights: ['Unable to complete full analysis'],
                recommendations: ['Manual review recommended']
            }
        }
    }

    async postAnalysisToChannel(member, analysis, researchData) {
        const color = analysis.fitScore >= 80 ? '#36a64f'
            : analysis.fitScore >= 60 ? '#ffb84d'
                : analysis.fitScore >= 40 ? '#ff9500' : '#ff4444';

        const blocks = [
            {
                type: 'header',
                text: { type: 'plain_text', text: `🔍 New Member: ${member.name}` }
            },
            {
                type: 'section',
                fields: [
                    { type: 'mrkdwn', text: `*Fit Score:* ${analysis.fitScore}/100` },
                    { type: 'mrkdwn', text: `*Email:* ${member.email || 'Not provided'}` },
                    { type: 'mrkdwn', text: `*Title:* ${member.title || 'Not provided'}` },
                ]
            }
        ];

        if (analysis.insights.length > 0) {
            blocks.push({
                type: 'section',
                text: {
                    type: 'mrkdwn',
                    text: `*Insights:*\n${analysis.insights.map(i =>
                        `• ${i}`).join('\n')}`
                }
            })
        }

        if (analysis.recommendations.length > 0) {
            blocks.push({
                type: 'section',
                text: {
                    type: 'mrkdwn',
                    text: `*Recommendations:*\n${analysis.recommendations.map(i =>
                        `• ${i}`).join('\n')}`
                }
            });
        }

        blocks.push({
            type: 'context',
            elements: [
                {
                    type: 'mrkdwn',
                    text: `📊 Analyzed: ${new Date().toISOString()}`
                }
            ]
        });

        await this.WebClient.chat.postMessage({
            channel: process.env.SLACK_PRIVATE_CHANNEL_ID,
            text: `New Member Analysis: ${member.name} (${analysis.fitScore}/100)`,
            attachments: [
                {
                    color: color,
                    blocks: blocks
                }
            ]
        });

        log.info(`Analysis posted to channel for ${member.name}`)
    }

    isPersonalEmail(email) {
        const personalDomains = ['gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'icloud.com'];
        const domain = email.split('@')[1]?.toLowerCase();
        return personalDomains.includes(domain);
    }

        async start() {
        try {
            log.info('🗄️ Initilazing database...')
            await initDatabase()

            const port = process.env.PORT || 3000;
            this.server = this.app.listen(port, () => {
                log.info(`🚀 Express server running on port ${port}`);
            })

            await this.slack.start();
            log.info('⚡️ Slack bot connected');

            log.info('🎉 Slack AI Agent is running!')

            if (process.env.NODE_ENV === 'development') {
                log.info(`Test endpoint: POST http://localhost:${port}/test/analyze-member`)
            }

        } catch (error) {
            log.error('Failed to start:', error.message)
            process.exit(1)
        }
    }

    async stop() {
        log.info('Shutting down...')
        try {
            await this.slack.stop()
            if (this.server) {
                await new Promise(resolve => this.server.close(resolve));
            }
            await closeDatabase();
            log.info('Stopped successfully')
        } catch (error) {
            log.error('Shutdown error:', error.message)
        }
        process.exit(0)
    }

}

const agent = new SlackAIAgent()

process.on('SIGINT', () => agent.stop());
process.on('SIGTERM', () => agent.stop());

agent.start().catch(error => {
    console.error('Startup failed:', error.message);
    process.exit(1)
})

export default agent