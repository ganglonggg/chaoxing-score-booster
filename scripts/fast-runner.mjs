// fast-runner.mjs - Fully autonomous fast quiz runner
import { QuizBooster } from './booster.mjs';
import { sleep } from './chrome-launcher.mjs';
import { resolve, join } from 'node:path';

export async function runFastBooster(options = {}) {
  const stateDir = resolve(options.stateDir || './state');
  const targetScore = Number(options.target || 800);
  const onProgress = options.onProgress || console.log;

  const booster = new QuizBooster(stateDir, targetScore);
  await booster.connect();

  let score = await booster.getScore();
  onProgress(`📊 当前起始总分: ${score.total || 0} / ${targetScore}`);

  if ((score.total || 0) >= targetScore) {
    onProgress('🎉 目标积分已达成！无需继续刷题。');
    await booster.finish();
    return {
      status: 'TARGET_REACHED',
      finalScore: score.total,
      confirmationScreenshot: join(stateDir, 'score-confirmation.png')
    };
  }

  let attempt = 0;
  let consecutiveErrors = 0;

  while (true) {
    attempt++;
    let quizInfo = null;

    try {
      quizInfo = await booster.nextQuiz();
      consecutiveErrors = 0;
    } catch (err) {
      consecutiveErrors++;
      onProgress(`⚠️ 查找下一测验异常 (${err.message})，重试中... [${consecutiveErrors}/5]`);
      await sleep(2000);
      if (consecutiveErrors >= 5) {
        throw new Error(`连续多次检索章节测验失败: ${err.message}`);
      }
      continue;
    }

    if (quizInfo.status === 'NO_MORE_CHAPTERS') {
      onProgress('⚠️ 所有大类和章节已全部扫描完毕！');
      break;
    }

    if (quizInfo.status === 'QUIZ_READY') {
      onProgress(`\n[第 ${attempt} 节] 🎯 命中: 《${quizInfo.title}》 (${quizInfo.questionCount} 题)`);

      // 启发式高概率答案向量：
      // 单选题 -> 0 (A)
      // 判断题 -> 0 (对)
      // 多选题 -> [0, 1] (AB)
      const answers = quizInfo.questions.map(q => {
        if (q.type === '多选题') return [0, 1];
        return 0;
      });

      try {
        await booster.submitQuiz(answers);
        onProgress(`✅ 秒级提交成功 (默认向量: ${JSON.stringify(answers)})`);
      } catch (err) {
        onProgress(`⚠️ 提交异常: ${err.message}`);
      }

      // 每 5 节核对一次实际累计积分
      if (attempt % 5 === 0) {
        try {
          const cur = await booster.getScore();
          onProgress(`>>> 📈 实时积分核对: ${cur.total} / ${targetScore} (今日新增: ${cur.today}) <<<`);
          if ((cur.total || 0) >= targetScore) {
            onProgress('🎉 恭喜！已成功达到目标积分！');
            await booster.finish();
            return {
              status: 'TARGET_REACHED',
              finalScore: cur.total,
              todayScore: cur.today,
              attempts: attempt,
              confirmationScreenshot: join(stateDir, 'score-confirmation.png')
            };
          }
        } catch {}
      }

      // 自动推进到下一章节
      try {
        const studyTargetId = await booster.ensureSingleStudyTab();
        await booster.advanceToNextChapter(studyTargetId);
      } catch {}
      await sleep(1200);
    } else {
      await sleep(1500);
    }
  }

  const finalScore = await booster.getScore();
  await booster.finish();
  return {
    status: (finalScore.total || 0) >= targetScore ? 'TARGET_REACHED' : 'EXHAUSTED',
    finalScore: finalScore.total,
    attempts: attempt,
    confirmationScreenshot: join(stateDir, 'score-confirmation.png')
  };
}

// CLI Execution
if (process.argv[1] && process.argv[1].endsWith('fast-runner.mjs')) {
  const getOpt = (flag, def = null) => {
    const idx = process.argv.indexOf(flag);
    return idx >= 0 && idx + 1 < process.argv.length ? process.argv[idx + 1] : def;
  };

  const stateDir = getOpt('--state-dir', './state');
  const target = Number(getOpt('--target', '800'));

  runFastBooster({ stateDir, target, onProgress: console.log })
    .then(res => {
      console.log('\n[FAST_RUNNER_RESULT]', JSON.stringify(res, null, 2));
      process.exit(0);
    })
    .catch(err => {
      console.error('\n[FAST_RUNNER_ERROR]', err);
      process.exit(1);
    });
}
