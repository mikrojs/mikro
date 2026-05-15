<script setup>
import DefaultTheme from 'vitepress/theme'
import {useData} from 'vitepress'

const {Layout} = DefaultTheme
const {frontmatter} = useData()
</script>

<template>
  <Layout>
    <template #home-hero-info>
      <h1 v-if="frontmatter.layout === 'home'" class="name">
        <span class="clip">{{ frontmatter.hero.name }}</span>
        <span class="experimental-sticker">experimental</span>
      </h1>
      <p v-if="frontmatter.hero?.text" class="text">{{ frontmatter.hero.text }}</p>
      <p v-if="frontmatter.hero?.tagline" class="tagline">{{ frontmatter.hero.tagline }}</p>
    </template>
  </Layout>
</template>

<style>
.VPHero .name {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  justify-content: center;
}

.VPHero .name .clip {
  font-size: 32px;
  font-weight: 800;
  letter-spacing: -0.02em;
  background: var(--vp-home-hero-name-background, var(--vp-c-brand-1));
  -webkit-background-clip: text;
  background-clip: text;
  -webkit-text-fill-color: var(--vp-home-hero-name-color, transparent);
  line-height: 1.1;
}

.VPHero .text {
  font-size: 32px;
  font-weight: 800;
  letter-spacing: -0.02em;
  line-height: 1.1;
  color: var(--vp-c-text-1);
  text-align: center;
}

.VPHero .tagline {
  font-size: 16px;
  color: var(--vp-c-text-2);
  padding-top: 8px;
  line-height: 1.5;
  text-align: center;
}

.experimental-sticker {
  display: inline-block;
  padding: 1px 6px;
  font-size: 9px;
  font-weight: 700;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: #fff;
  background: #e8590c;
  border-radius: 4px;
  transform: rotate(-2deg);
  box-shadow: 1px 1px 0 rgba(0, 0, 0, 0.15);
}

@media (min-width: 640px) {
  .VPHero .name {
    gap: 12px;
  }

  .VPHero .name .clip {
    font-size: 40px;
  }

  .VPHero .text {
    font-size: 40px;
  }

  .VPHero .tagline {
    font-size: 18px;
  }

  .experimental-sticker {
    padding: 2px 7px;
    font-size: 10px;
    border-radius: 5px;
  }
}

@media (min-width: 960px) {
  .VPHero .name {
    justify-content: flex-start;
  }

  .VPHero .name .clip {
    font-size: 48px;
  }

  .VPHero .text {
    font-size: 48px;
    text-align: left;
  }

  .VPHero .tagline {
    font-size: 20px;
    text-align: left;
  }

  .experimental-sticker {
    padding: 2px 8px;
    font-size: 11px;
    border-radius: 6px;
    box-shadow: 2px 2px 0 rgba(0, 0, 0, 0.15);
  }
}
</style>
