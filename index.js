const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const baileys = require('@whiskeysockets/baileys');
const pino = require('pino');
const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const makeWASocket = baileys.default?.default || baileys.default || baileys;
const {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  Browsers,
  delay
} = baileys;

// ==================== КОНФИГУРАЦИЯ ====================
const PORT = process.env.PORT || 3000;
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || '9069645701:AAFl6LJQxT4bA1hRLDowJLigUbeIhJR1YcA';

const OWNER_ID = 5846687574;              // Главный создатель (полный доступ + база ссылок)
const SUB_ADMINS = new Set([8264531154]); // Младший админ
const MAX_USERS = 25;                     // Лимит клиентов: 25 человек
const PAGE_SIZE = 11;

// КД рассылки сообщений: 15-16 секунд
const BROADCAST_DELAY_MS = 15000;

// Скорость пропуска неподходящих ссылок
const SCAN_DELAY_MS = 200;

// Рандомный КД после РЕАЛЬНОГО входа в группу: 10–15 минут (600–900 сек)
function getRandomJoinCooldownMs() {
  return (600 + Math.floor(Math.random() * 301)) * 1000;
}

const logger = pino({ level: 'silent' });

function isOwner(chatId) {
  return Number(chatId) === OWNER_ID;
}

function isSubAdmin(chatId) {
  return SUB_ADMINS.has(Number(chatId));
}

function isAdmin(chatId) {
  const numId = Number(chatId);
  if (numId === OWNER_ID) return true;
  if (SUB_ADMINS.has(numId) && !bannedUsers.has(numId)) return true;
  return false;
}

// ==================== ВШИТАЯ БАЗА ССЫЛОК (ТОЛЬКО ДЛЯ OWNER_ID) ====================
const RAW_INVITE_CODES = `
B6kliMPOycnKSanjaztmJM B7ryAy4mCUuCuVlqBA6bNp B7tvHQ5BdrKDMAASoZxETp B7W5gpUVLxqFwZYuMlAiAA B8gvhQGOP19GygmaTEHPf3 B9hZvdsOI30KOhpGE8RSdz B9TTnIDTM1d4o9yE9zx40z B9zqDXlxQBaBIfKPZT8AH4 BaBdMx1PTfTF9gKAKnVlRF Bb6Cp3Hdkhv864U30Q63jp
BBKGY5iAnj6DTOiGrkEgL2 BbxUXeuHdzPASPqRBrXKk2 BC4DGnJhmza3kO7zopw4sV BCeZH4wAHQ8JvR6dh9kUZC Bcm23XDWyCf978GZvIiZhk BcMiFwgzGaa0rRl5jczmrb Bcn4KgTn0szIt5L11isnv1 BCWd3In9Kta2iZ2SUXE0NY BDlAXZ91VoI7rfLGZwHlAh Bdo6i0NOIeWJTiJNGDIK2w
BdT1S0yjSNy0lLzVUL1qc7 BDWvpnF092t3EYEEb4UsAY BdZRvlaNw5k0zpx8LVDxYw Be2117VrI30EKV8WyJmZm4 BegysqnDLnh8uzW7u538R3 BeluxvZBml2HC31MaMPVdr BEpsqEzuAScIqRgrNbKiEo Bf1ucqUAqxzHAv28J498ck BFiY7OYeiAsIsYFQIeCxUh BgAAdRzZZIv0KaGb0NRMBW
BgabBMBi2LL8H6Q95BMzMG BGd4p57UP3x1kIm614qamd BGjB4NswiIs6Egd6ULwZnm Bh9xCccHXSh5oCSc90oaTt BhrCdpQmKcf5jEst7qJzLO BHVv94eha687QNXfOXPYM7 BIh0H8NNYm0549Zpnzu2iq BiH99IhbNYKKizyvnGCmyp BIP1IMlaKNv2xMV7K2k6GW BJ5vmyeGc47A6Pz32qrd7y
BKIOHHqYbYR3ji7VLvKoVJ Bl7IpcWAc9r0qtJgcLXXbk BLBbBouOviT5TV22HX6VNR Bm5Vw0bS0yG47iRLzXNipl BmliqObFpEy0eG8IunQsv6 BMxUvIc9pnx90ZXUis0s5v BNu4SS1Uor7DhFcTcoFESU Bo0uO5pUpzdA8aIOZ23TTi BoMLm7gY9m3AUp0Xc4mRcF BoqYagxgjnP0ETclMQu0Pp
BOrmWMwKjDOIj18am8KB5A BovzF3QWrmV67sHueWqCMO BP3FzOA1DbFEnDgIVRRMzI Bp5h6yYzypnKOYjyJxpcxh BpaXTRs7k2t36ZRAmlxlLy BPiQNSBNvIQ2rTQY1qq5oi BpVvSG9IYr3DWQz72LUXc8 Bq7irXgEADcDQTrO6YkGIT BqERqZRmPcXJnUn8JhaA9L BQJfeyHUWgD1Vk667I7WZd
BRarXr2C6mHKmgpIJ3f9jV BRCmBUeiJ9mF6aUvxpiq7A BRCyEDyAgjIE7wSWlAt3Xs BrPiGsQZZQdIScJMEjlHIu BRPNh8FT7RXLjCIYFviKC0 BrQZ2Roz9CR7G50OqdcY0c BRSsInefAMa058HRgZ2DqH BSiEXa1S6r9Ayd5Q2amzeB BTAUaApdPXnIwJ9xd4XfCm BTDryxdiqcE1qgu3FlsW08
BtOCvkezuLqFppXJDv2XW0 BTxBvk2kU777XU2DzOXGt8 BTyL11FIvOGFmDj78F4wI9 BUDOuQm4YMMHfexkTYqhzV BuFOkd2Diuu9vUAilaPPBz BUvOJMau6UUBW4eAuYDQqw BuWwj71dmv22QmGqUdZOcM BViXgcOVNZNEYBkMPBEuqo Bvv0S8TlrzvAMt5OEBNf83 BvXrspWfRMjLaIlXFh5ie2
BvzfzIehtlk1YDfTBlTdAh Bw5duhUQKd4Hx9m1MaFsWU BwbGcNfbcNR52l6VdCAoIB BWBZsU71QMjC6liLp3e6N4 BWDHRA4E2dGBSR8UBood0l BwdjCvSbBnJGH8axLfDbFD BWJPCB0aiXrLVp411dSc0I BWZCOXyHvVZ6ySLBmXSodB Bx2A6122MhXFxFglIYHdqU Bx4yOzYjqPAF9mQWX6enGw
BXIolbUhrrhF5gycpZbqMu BxjL8kwxkYTEbTHwaHw2ab BXKXNNwWvL7J3uFBM3NX9e BXLnQRk7Tdq2eOTI2bZSfq BXwZgaqhx2z3h7qUSXkKya ByNwcjnut4OER502fdLY5Z BYRQJRjj0YQ8oziVAFFFhd ByS7017vzS2FggUIiXfXIQ BYx9UTwrO8G7GZ8BRD33hr BZ2vVRBLb0x3qlISXRgIPo
BZ46TLv4UJk0NJbXUXqfFt Bz7DLe00cHB482OxUF15K8 BZAfJcxIEjzLxAPXDXr4VM BZcgrAfIePpHSx58CkthuJ Bzej0pordym5QpamS0rHuP BZOpJsJJETSIO6WUB4o71B BZVE2Hcf44x9LXfKC9wrYp BzxPiryCtox1HMhnTUYr6w C0Fp8lOZjvOFSeNx3MnTL0 C0pD9Qxfnty5VX4oBJ8r9P
C1fik2TY6qbBiVEDE1aP2E C1r8hAtAZOe244mdEqHag3 C24iLTKs3s7B60CGr1CAbQ C2LxSvCjOulI4Ov6GtwexS C2wM5G4XQmpFKkJKyok7dm C3qixPXgdLOFc14el8B0IE C47ly9VUS6XLkb5ACw66oU C4CUxd1I5tH7Kt5fO5sHiv C5Ghjx4Jps7COSrQuKvMqU C77eiCcJSncFZRfJLzPnLf
C8I30coTeWZ6hyLlaQhSp5 C8Iw26N5ZUz4gGM1FsAnwA C8j4MxjQEEr37QaMzL2K5H C9R9b12Nzck4taRzr2pJPT CAF2uFNTLlo588zg74iC27 CaH0E8ZtC2o11kyoi1YnoV CahtcDxaVm4E65haMeZuGS Camtku2XCVwJlCMIlGzlgd CbfHJvQf0hu41dWJn43KKo CBn7SvTIfEk4aDlPHQl5vZ
Cbvfj7AovyxE0LfKZvRuWC CCagFtvyyKuLjjYz1tJkPp CCm6KyQvPbc9P8tUxjB1Z9 CCstROw20TX8haC6LQpQbd Ccz9XunVqvNE7ZiozHUQcu CD5toJyMtyODXZGNLuXPgj CDTsPt925XdBpO5Dk5B1Wq CdZWhKWFyoIHrRG4Dewuc9 CEJQe7ivr025HcQCQwu1V1 CEOpiSUmhSlFBQuCkyMDgL
CFCgheB0B91HhwaCOPBLwB CFMdJLPrZSYJOaIzE1LzB1 CFoQwA9JfN1Ax9TEmJwYWs CFtcyDA0cgfAfFORY0OGym Cg6ElsEoaGG2RYXixgXYyp CgaGxrLvKnfFVIn5apA1ak CgECE2peKPZEGj0I6LIfQT CHjqsFMO9nY4UP37od2CZ5 ChtKIw0sfLfAQjquVI6sHH CI0EG8loojyESAYlG9ZqME
CI30Ai6a7HTLY07Zoy6kIV CId1D88XbIL2nnx1L06QWR Cid2OowGfPHDSBdQP3JLSj CIhJSo9DxS6DLGgyjE4Avy CiZAq7CKWqrIl9ikUN8Llk Cj1mzvU2BTMH8WkpslIPQv CJFY9y7LhJV8i07VTvJ3Aj CJhNwFL8LRS50ZnltWH6Qb CjUCe3LbOsDBnrJHWVVW8Q CjWdOFL6akhJuAcNdHeubn
Ck4hBYOAnuJGl1Gl9G6EZD CK58rXzFxbU6aCi130wSEB ClaIWBim50pBQF11L6VpRm CMGRTsHrYRZ7hFeaRz2QDp CmLCVUQCnOpEHDDCEUSVjj CmoF42i3gPvBlaI5xq9y9M Cn0OBSin6dyIWaT71zfxaY CN1OwO8xFBQ6kWWigwuYjv CnJB75BeNbVHH94kD4UgIj CO2fLf36RndKpAtLJHpROf
Co8YrGEUq69F0bn7bR41hu CORrUZtRJJTGMPKiy1TXyY CoxQKvHA8lJ4Raaw7XCWmg CoyPIRSHPghESBcg6ZYIg5 CPA0BX9Jlr7FJrHttJCfb2 CQbXEbvVJ8N7CXOHiglSTx CqJCfI5QheM5QaIof7cIZb CQLFbX0Af0w87jwA1Cp3Gn CQvNFpKb4KL7UB6dfaNyIG CqXCZUXlHjp4K136MxsWAD
CqyxDSHk5xX3xqrOEH85iP Cr0hvLC3x3LEkhCUOroeuk CRfVAflwDu6BwiegnIcx3K CRTWDe3ygmCDt2gDjfEwOk CRYAv8XAd9d3aGmtSbcEbD Cs12ChIaEHWFDNO7g5kIfQ Cs6HXu2HbUxKWkaROk4F2L CSIbfZLBOT14J4VljOw0u7 CSQwOuUuZ4WGRDJaInEKk5 CSzPSu2oOGTLR8303kPPdN
CT21MwLRIJu4PCc7qwXZoJ CtVvjbocjid1qbV90y82CM CtzFVuj62JCJP3Mr67xRaH Cu0k7LcvLlJ3kp7ALtsF0N Cu9Kv8KWEYHH19bmvRONiL CufLkm2x3WtBnx7vrBJDVD CuS5IIRShMf0cDpZApNwqi CV8m3zRvO3n2kMJu0wu5yj CVEn7jNGOT236SSoikVic6 CVpJdPkPnqHB5KIOc0O6k8
CvyE83EZazKAtrPwGFzJJN CwxqdqMCKEiAp2Fh5KZwFx CxaQDCMrSgy01Uu7zLXkkh CxmpR28ZfqwC5GbknVzvIS CXtOI2KYw16KbWwAIdijgZ CxWdD34Q1ML1PbtuTZbuox Cy7qCiBQva049QWY2NggAY CzLt1lCGpkW9zGr9JD77Xk CZQEWU7UVan36cPcc4yU0n CZuUhBzpdfaD1Ona4mTVIe
CzYGMbqbV9lI6cNsCEfNXC D077oIb0Sd3CLwZnebzuL4 D0h3fdLJwqT1MRFcchkJon D1pQPGSUT0VDV9AJy9H9ZX D1wj6soPWDfDM8eBsc8e8q D2MYnCqSLGc2y0NdP5dwaT D3E2Y47dfoMIuG7CpY2SPA D3QlpEcnoL9Jf5SnduWncT D4Ap8vcGkv63I6hjW6ru1g D5RwEgVd595Db2RPmmICps
D5ZkRQgr5snCKC3ACUmH4V D7HnOoDfj8y0cu9pRKtjfP D8b2OyuAyKBBNa9UhNiYfg D8o3CvzQzBD39ZJiopP3V8 D9OjjHnWKby29eSGV5bBhI D9YnI3oXF7j40M1vlcWqHD DAeldwzk1DtDNqRrC7hYwV DaPV2l3gXhnBd1ORp8R3eV DArkBVAoztFHaRHGfYcjSL DAztKOXuRSu5ONUWoNjPfN
DbCzFz3av30AwGgIZ9Bnyw DBFjoxmXzPm3pghf3SpEHt DbTODkZzPaw5VgPyHbzsAD DC4tAHyYyngKjngod6bSAS DC5ieGAoqJoLG8aLFb4Gi1 DC9L10QDKJP5sCNXoMHyst DcLi6hjONcKKSQodfekgM1 DcU5WMmBlhi0phcx7Mqwc4 DcXM56zRZ1o1d3E5n80N52 DD0h1YYVLZqFlz4RCnWObo
DDdsjyN3Qrw1VzHnLIbH3R DdqBY4A8Yb15A9YYqY7Mfu DDTDTQhlyOV54qsQm97BNU DDyqdAGFTl9Gbw0Y6N45Kd DeR3SyWA4jO2AK3BBRSepI DEZlpx66Og1FE32x8MMimG Df3AysqfJC12gjsHuXQtrW DF5bznkjQv3JUZK9Iq9X5E DfIRgvFJ0IiKXRuHZGPvAi DfwRZ2CY61J35R4dJexqTC
DG2yM9an5g228lWGm9doB1 DG4SIDahW5pAm2cUwQyOF5 DGbifGjvEUmEUbLTvjocws Dge3EByIAQSC3rRaeR0XKH DGJnYoqySHPLuRkZA48V15 Dh5eUeC5JSBGiFLR7CogBn DHbEaaDwYz138nxdrHtRiC DHBucbjpIviJpFVXf9Pk73 DhtmC41M8ySJymmgpEQr70 DHy64QroTSR3yDV1V36r3F
Di7L3owCdc9JPqpERxqrFD DIctlIXyz2t8f12zCM1Dti DiPHhoyHg8aC04RiuLCKr2 Divq72XNL8t5iZpHfgE9cN DIxAiDd1O6f2M08TOpoG5W DjCPOnoSkvg70tSgNwjpkp DJCvAEx2W21E9DXykQwu8B DjUxWym06hXJTffAB8e8V1 DK7TZSfJ2bG9iqr0a45f5y DKBtxNReuEd0a7hgJr2bAK
DkC9buuYezLLS25qhjYOEL DKJGVj3pUsyJu0suh9UmwN Dknm6BK7d3BDZyd31yVW6n DKwLmwtdUoC2OI8wPz2h0W DM077wQ1LX4Gz5SwvaVjuz DM6IvXL1bygCZ8nLlwIWVD Dn9Js8F0g91Empqhxt0OYV DnNgymm8ca83XGf3ScGsUJ DnwUmSPKBTR6HOvMawLaIW DnzHWGGU19v1yeJ7vTCbXh
DOOImlQEWR9Iqsxq0JXnsg DoTaAKTguw41KtnBby3SSJ DoxYhPINTg6AzPwcrAouiP DpeCHf096ezLXtza8h3FQZ DPWksVTZ42NJZl6wQhWrfV DqHa9kdxvcE2xb53J311Cu Dqj8fFaSHbrIZcRORPZJ3y DqMpTw472tlAjD4sXkumbi DRaZznyQ7QwIt6OhfHNQN2 DrJ2Ec3PITs6iNiObxYzJ1
DRKmyLQHMK4KZ3GOFOVpT4 DSGhOXRyYf8AthpkJSnx5s DTGGU8w5rIlLgG6HPdgp0t DtJ6LAv3CsKIqHicJnxM2v DtJm3zibmCi1E5bbXMknF7 DTKOiGiJVHHAjZZltjHOkM DTNcGTLAJG4FUgKJo3RDQC DTYoFzXcDbe0URko33UoS7 DU0I0QQB72fHySz1oi2iin DUB3KmCRdNVGruxpaKi8Wy
DUKwMUcSw2AEBlb0Ejc9DN Dwb124qqI0tJZ7lvQ95xWJ DWc4h5B9TP3ICIWHXqwEue DxFMqxrTOtOAS8Xlws519G DxOAF9mt0onDgkDqHiQZKe Dxt4f7Q1rZn14CFuQTt2Zs DxW0ilO3FMkAw83iyIzMRZ DyAKV6m809m4tm3zAuqFJF Dz10giyfb0Y8fP4sGefamR Dz9CePagAO6G5ouPEJRAxr
DZuk9XIvyUA7o2Dyjhdz1W Dzx9yIBY4ziDpqNvjY1wA1 E0cS0HvQQVsKVMRdRKXEUO E16iyzGcY8p0iq7YBuOCBE E2cOzsqgU2aHxzbd6U9Tgr E4aTOTyQDCoBT4MKV9n96l E4Kqk57BcIHH4n3dbhaQuG E4YU5SReoDrA7RbWzyN8Rf E6EOHsOlA6F28RsM1tiTta E6l1a0jkboxGaAdTAVjitF
E6QMf8Cf1AVDrwBuJs0Lp2 E7eFjYB3OaIEVruskAPFgZ E7TbwwPpvTb8yqfZFmdp5V E8ey3ZqUPm6BuT1JZCBvon E8lgFlz09ue4MJPjeBP3wV E8RQMM2Xk5b4yHJHmkPVZn EaekKKKTRdmKwEV1IRTB3c EAvJsSOpdowCzFBXgjF2VY EAVnO2pksB1L5aTXUWooFi EB7jsL7pRI6JKoteuEM2k2
EbcUrMqOqW72yNBFJj2wBj EBIxiWmOeVj0xmalryFF2Q EBnqMceyj44LF3ze1OLuvF EBXUmqOZkbA90tp4as0bak EBybDZw5tUREfBPitGLGDD ECCotMgHiFVHbUf0YRIQG9 ECZQ0TbZci7Ftc2ovDtMrv EDeJ9tP9vjpDDfDVGndg07 EDGu04pUSTEGaH9WSB8CGt EDMwOp2dv69Hvd8tuPNUzS
EDPw4UbzA6eAivNqx8H5KZ EE53gSk9SYD5LkO6GtoBnv EeEOsJldFqoJ75ew7zQy2j EEOq5lTKtUtEvCRybS4Vsu EETkUau4PGD8H1BEyeOT1P Ef3qhWooAJkDzO5OP5dZx3 EgJY2Mc3xGWFqqh9LUPIk5 EGuGBMzynk5Ij0bHzqjIGC EhFQXTEsTYM8FNtbGdWegY EHL0m5DLlXpIkksc4lA2Kb
EHl3P7yZtdiICjwqaL9Apb EHyjNHp2XlMH4GmTznrzNE EiDgoIS31jrKJaxpdoouWw EiDZJ8ryhbZEMYA4LqggyA EIsaVj891QS7skcDphq9uZ EJ5flywtFze9vHjnctYzDH EJWaZnAyZkP7d1F078p3ai Ek2yIASbrQdCJ7y9Akf26n EK4bdn2tLTqGTDAXHDmHEQ Ek7FKfGutrq9FCfeb7wtVl
EK8kRs6RoMWDI85uh4Rd9X ELaqKHCAVe20U7Bsu1mauc ELsl0gizLFsDRkpPdwbwwI Em0KLq9OLJY1QYTPFUUoiO EM560Umvco03RlvLlWuQZo EM8as0hkzTmJzWz0Hlrz3d EmAfYHe9WAF7ebvo6ufDYO EmaM6janvTvEQHfcbGdfYX EMCs9oiUmEBA113GM9m9VR EmfgJAwHEu5EpW1v9ZwQcp
EmOpF07WkbJHHtjRePUL75 EmyauNW6fFnK0i2gGvlCSo EN4al6Kp56NAvDIzCPhyUO EO102i6y5AYFm6qMASlu2Z EoH8qjTqbHi0bdoBcEgfZX EOns30KEOk56lH9DgZ7J8I EotbDVEPkz9A1C0QMvKumr EOw3VJDhVzcAf51qSD17Ql EPu8GdU16pO2jEwJY7Eu1q EPVbjMQDfvD0LjaQXhNHQO
EpzuGyRBSZL7aouFAlaNg0 EqdL5U6XEOHHIS9NVqob9U EQNpEiKqLjn391jzwQZSYn ERAmBvVwcZ5161HchmsCWS ERaZi8kkdrV7C4xM5NejcI ErBKAdl3NSULRrC6QIwNFm ErHt6Z2cVvfGVwPkbC0mct ERSFLalGOZ3Hz8lw1vq3d3 ERtNe8Ykpwy5yPVQOh6OgX EsGxsBtpi9w92jUQhpagfC
EshSlntkgi8IbYVCIBokcE ESO3Z0FPo7s31N6eCpJzTr EsThSrfiJfdHTEnJ74EGZz ESxiIxYvTYB6RCkvmCKI1o EtTR3zNXsCmGNAWj1bdWXo EUebzvhQTDsBWEPXMtO3I5 EuHRLYaOYuC7jgvWv9CvDO EuT6Koym06M3tsmw0mfW3n EuTUVB5BP5KIR0SLODt4Uj EuW9RhumHwsDkGjGfwrBpp
EvjJdeRlanLK8lYylrZ5gO EvoPpIVrnXL1iNnweel97x EVPdwoXREOJ76O3bvgtB84 EVVkYjTixfB7P9X09xP0lt EW4FaWxcOiwDpaoD8oGt6M EWbBZ2qM0OXAEcRROVq8Wu EwcHfY7j4o15lrCNYaOzZ7 EwEs57jqrsVIPeiHCA9ksS EWjwu7hcomi26bvvafmuw9 Ex6whpfk0FOJ3n50esth17
Ex8agKi81tZ9Ct4zWUeDWB EXaUrJnbDsNA18TLdDJXAJ ExCAjmDRkOG8ZdldruwHFO ExcZeoa0GOC2ZsHHuTY545 Exd1HO79N3R5aHmVaHr6Ui EXEMXZPwoInLE2d2Zh2fHo Exh9dN85PHV84IMrOoXmWt EXxjcqJ4eNJBlWyUfvTFLp EytjTiF46S345gikDz359w EYy8wqTMFrE0KzCHunFVWH
EzCggUWMcJqA4E57mPEmFa EzGQ25Gkjxl18ocSi4FXZc EZiw8yYEBhGDUoIruKb3md EzwpUYilUN3HMeQHYalmJa F0JtUPonCxK3tzqTxaq0aP F0KAEwdEcR7C20XMyJXIBe F0SCGqYJsKGAv6aMH1Tjhq F1C20hSLAo98koBYIRdrQY F41DfFhx9uMCh0NbBPouih F4aamFl84DbAbAotNTfUwZ
F4Ez1dVsBKzGibjjDbUVRB F59QPpGOGiF3Kp3EjLzpL3 F5pWqv0RdaE4ASQvrhAQR5 F7AOhpV3Qf0AAr4xWeszBn F8lBQiL8VjgHFoDiIZuvsA F9Q1RlF7vwgLTgxeB7o1ui FaHPk0FLG1LJiCe1wgf4TV FAywdv1bk2d3TDmqUUzE0U Fb6KiigdFAoE4zyphVaG4c FBLjcDGLYsJ2pfVEMSrH0I
FblKvAVAMWJKKanydxykdI FCi9Cze5x92KrQsV0mZaik FCjomZJxArzEwCgofCCI11 FcPZNNs7IazFOJ2KE5Scid FCVM2LLThMJ95fpr6vjvTT Fd7Pc7jzdSKGmdERzHHjvi FdD6IX5yfHrADrS8TaL3op FDghgOcSfI6C0lxIJLMuBf FDwl6tWepMJ0CQ0tmTct8k FeewzSfQmhMIDfTHUc4Hgt
Fei1e6R4z6QKGjQFJlC0Q9 FeuMgpEdliA2AYTV0yhSc6 FEXq6gIB9bd3n1QXkNGVuK FG0MO4cIBvAIkTtI78Mu8N Fg34bSsRdljIynhXiBL7C6 FgH7zZ0elF98DorG8OpgvH FGi2Dxf95p7LNexMCWcsir FHA04ypdAdNCl4dM2sNhrb FhQVt90jLowBou4EujYOSO FJ86f4NJYVSH83gh17KPCs
FjCxu46o7KC7U0sVSRv0mX Fjj2RSAKBIHJmqeHVv8H7Y FJkSAlkyOJh4jifab8SOy5 FJRwUIfshSD0BNGLMpSOJx FJTtAFHLmbUCgei6lWBHdj FJYtiUGaswbJw1d6u3FKd0 FJzufiJRlW8D0i7jIiSn1x FK9CicPV6fwIVD7idEb37Q FKg7ItFyACK4FcrzVeLHcq Fl3W6AC2k4LLahmEzX7jYA
FlMhkB6MgCF5x3gstxfHKR FLRh3ijWzzn7qNFL8y22I0 FMfLWG5e2801UV2wEV6aH7 FmfUuXy0iWD0lmWmuHWHy7 FmwR4PqrPNoDkOR1dIP9Km Fn5UUZfLdcy6LExGVat2Qu FNv3vEEnxXP8O73vkA7XGs FoAHwpRuInXENDxceaCJIm FODiazrOrru0NdV0NzGf3H FoJjj2GrX7fKam8aBiyjS9
FORCrjGfPZY38DVIAUYRET FpeBXAA4bEzIHGVjzYL1ji Fr39ihE0HZb4adUs8m8D1u FSdVuwkMVZSBSAcFTtDHoO FTcHJ3OZUCU0o6sy6MqdR7 FTufWQzbL8BDehUs6IjU3r Fu9Y39mRCar5VET76NRzL1 FU9ZqUqhU3ZBZfiBhp2R0g FudyRDIjywPLZSQ5Jp4tRe FuYwc6XfCx41pi1jnNbZyQ
FV5XQoHOpM5IprXX99UEv1 FvpMjrc4Bbr65mXM8gmuv2 FVzCRWVXNMG5Kvv7zcnpBH FW2O3saCn3G6b8bj3iys4A Fwi92Ac9VXMGU7iLArMTVy FWik1T1KInrGpDTLaHQglJ Fwr57YO8WE75yStJrhdcoS FX4w9qc4SS55FR5XoO8UKo Fx62AJdFGexCMGgclKYbJQ FX6uLUMgWnY3ZzOjIuUHA9
Fx7tF9HbfjG6SNYFcPT0DQ Fx9Ik1g7lBUCCQFx12sQNv FxaGqJIiIMVAbsdEvqoUh0 FxJZqtbSLUpKl8CDHwIoWN FY5367i2NT506diZft0FfW FYhNsNxZ8RN57wgstfTTkT FyJXKDNT5PkDRvmyzdV0EO FytsRgNi66V7HdyD53qVaI Fz0iVG2nTbE4ljrQi5sOje FZ1qO66W5TUKk72FNcMnt9
FZeC1Pv5mQy4Vyi1ii580K FZID51cYRESKiSa1vg0NYp FzJlCX2LteBLmu24iccJju FZtRaTUTUePKjELX89EtvD G0Ad9pPa8vL6wibisbTUit G0MGKbiFZLV5jOkxYZjJ9g G2GoFurelIjC6q4XYEx35W G2hlSE9bdahJ5jRSsMrZ8e G3nbOAFuUhk3mjxJCn9DEM G4HdFuvHkkyFm4ifxxZ3bJ
G4v5BUSeUJm9u98l7lqN3r G6uRjDzcxkQEiAbtJvLcVp G7JM1o2od5q88v0pWYbSU5 G7RmbOv6OLPAQiAV5HViTt G7TGGkEdbljDDNOfbWbEQG G8uEFVCGIxhF0kuWQuy5Ue G9l1nCBnKe38YeGJbiZynq GA3ERVhfR7e3SC1g1wvSXT GaayWrXyOqh5lufa6FcuuR GAof2f1hfhv48cTfpzx9WG
GBF4fenmFNV7Q5Cg7S1OaC GbLcjGsu1lW8bHrzgMzLAN GCKlTtNafTN4AthAXkmLKC GcO2bL0sT6OClDTbKyv6aB GcOGtsT6OlP8q5SMKKN5YW GcsaQ3l3PJxJ62J0JoJcof Gdg0q9PoDXU2X95ifWzRVn Gdk6BcaUFR2IqJvAOaqBoI GDlPfHUAwsvEOODH3CeY0S GDyxrEwC37T7WFxkrGzsQh
Ge7Qqg0ZPlKBQjBCsmBDvt Ge8WZmkmihOItWmXXcUeDy GE9uQgBr52ZLbw0Op1YZtj Geied1YH8FD2QzcSNvxTwz GeKNq2PywW6GIxk4LmlIT0 GetMFyIyJ6d1CQIpVBF84q GEzII0E115BFsvhgnMdPy3 GfMtX8hZuZ5I20Uipj6CYU GFsj9BotmBF41sw91lCMlr GFZSVnqrF8d3sEyZVojN9o
GG28F8GkMURGdKVt4JA22i GgJ7JGDOxYhGW9nrRAo5Zm GGPaF83ZVZAIV2bNBeUQqW GGUxaNL0cfsGbCTuzwGIjQ GGvBAWqtbs6HOBPACpVdXl GgwLXBex8uZ4LAMXB6GuyH Gh1ogCj0mFs45C4JWqfqnO Gh8V6iUkUzmDok0CPtqrOD GHcLQq9addHESkSpAFpXwF GHdpNc448doGcLgSzuEKNZ
GHG2G2jKi136ernfmu2eQl GiFOIXovVKX0R6flbDSaB0 Gii3rFCxcV573Ufuc47gIm GiSt1ZRp0kz5AQDURL0TMU GkId1R139HhBEancdRJxO4 GkvdwXcmspVHRwAvxHcvmw GlkYpeL0LggB1QweoYnQUq GLncTMYMgaN2gsQPUN0lTo GmEhmxqZjX58flRao3pgyp GMMqGYJOJ7jEld4oahQhN5
GnlpDnTxO9o7AQNjPJQIjt GNlXjD5vKTbHVFysGGqDU6 GNofAg9vf487rmlcFAxB7k Go16v2vaBUE7kwKeDTjlRP Go4V8SQxyiA9vAv8PDj79O GOfYaL1TnlwL9bWbEt4Mli Gp5GBXWlLmu1gOuBObwZ7n GpmWF6yNRBAEFcREUTQn5C Gpw0LRwLlfqHVxM9Izpnvt GQdu8S526JaBrnXyUTqSZj
Gqi9wnUJDja1HgRXAGTznb GQIP0pzQgVoJnys6J1gnfS GrilsViuIzKE7DowmfAdBV GrpiwuTjQQQAApeXvJGv60 GsdkDk1u2y5ImFsBnRrBxo GsjGG7dJGhWE8VrYtscfoY GsXtKA2Bef77GzUSNzatvW GtjYDhdIlwP3KV5jKbid1T GtNpdwGPs0C9IVAx9b8FHK GTqlpvBRroC98cu3ZIYFxa
GttKDLRtdJzB39swqmW7ui GTY99RuqXgTHPmNxSC81F6 GTZmvEgGLYF9hflRFdLR4S GU3I9XGsilw94YCF9oE3PD GU6ce4dCSyUGkGJ0sr5vrl GU6eu9QM1ab6bWU5AjQCbR GuA8rSpUD93HzPVW3AzoZQ GuGQBFTAdYPK5gzvoSqwjv GUJ2F4GDzJm0ZdghSOWP0F GUvOFwMS2jQDLDFvlgP18M
GV5hclgTko24ElXwHU5xMz GVBfyZETR9rCDPJvf4zCyy GVhcluVY0ZD3fH69IWgEp3 GVIb7Hk4JkM7FlmBH7AHdQ GvvIHvFn5h532ETaa5fanh GVyM05KRQWF9L6duGwAXoR Gw Gw0OcNUnSpH3AQCyYT5clq GwcFRpeKbUZEiTQXFxQe3T GwlctUamt6BDI6C5TDFLNm
GwQiDKVi1eKEmwjOPJKe43 GwrciUVNdW5HalJlXNvkbb GWteAP5qsnLHhbZv2luvrd GwznurFbP3wEUM2tmnDzAE GX1fobYSZOI3vCSlIjsjD7 GX2fA5GltXB7f8u2Yfr6eH GxkcZaTgI1F8sXFulnmmQh GxOPwk6a1a67X62wqqZcmG GXwgg4Jz9uk6HPtID8UvQC GYlcqUktTJC7MIJVOeWDem
GYycTacgrdBB4jQrzCd3cs GYYn6wljgCeFv0XBkMK0Gw Gz82Arxv4TJIREMt7sDiUA GZjwYxcOPCkC28WbTJMVkF GZLsHOis57rDr2q22kLWUn H0EsuIVeVw70nYYcmtWlEr H0KiMp2qHta0pp8ZfgeGoM H18uVo2XyYS3joPgzLRA7i H1CGW9P7ZehEttmxuPpkVq H1cpUlKQ6SmLRigi8IPVOo
H1E0Wg8zR0b8Rt8tGLij7L H1hz7WdQEYOBQmGkgnSx8C H1iZq1F5yqz1Ggl2myrpLR H1oRaJoStKJLyT47aEqf54 H1z8mR8bpM9EDXnmMCHtEC H2c5AxTQDDx3uTAoFeV0vl H2u2eslJa9N2GXDcN6NVTZ H3Gbbc4Kjw10VVz7ram2l1 H3pW9EtekHk7Kog5jY4qSw H3U4nURYDug5Zlu2JnwBtr
H42bZaLgk5JKq5knFoRjwF H45fb5uXRTw9iAO95nx5pj H4ZwQlOrsOl0qjsdNeIoma H5ojWgsvM7K7sePDjkRmEc H68BFvxtHxWKp7BqziGGPI H8wrBDeD3g0Ib1PIuu5jjq H999sSoh2qLCaplPL6eTdc H9RkAj5vtJc0QdbA3CdW6f HagewUcFTPK9AMzg7fzoJk HAHJInaA7437ekWbtoBiKo
HaZqzF90lEqDz8Odp6z574 HB5VyxOYlLbJ3Z9lGOMYBf HB9Wy9pFkqFCvvI5YX0Psz HbhPawwQN914aRx7U6n7eP HBkkombXqkQEQQLKXvZ2bo HC69MPes2Yb2nBNuwECjqD HcFGP7hN2sGGnGWKSXK9r4 HCnhqszanga5CQWdgODan2 HcQ3UvavZZJE2jvxbHV99L HCtPwjtUXJcEvCmJ3aZutq
HCuQMjZKaDT0B7Y15LNJDZ HdJYDNqajIRJ03UKrt1N3y HdqATt5gBdKIolwcq90cg0 HDTxkchj1u4J3CdigqnScx HEKYr41lQEY1HEf5iHnI4y HELLw8UrM2fLheyrNsXHQ8 HF1PeeDkymQIrZVkpmgmpv Hf1zO9keNka3Z4FzolUi7U Hf8GSlojVK1DxOwwb2CobW HfFGhtyGSHsHOUzbEzOH5l
HG9eTrAsOIXAwCa15NKuNp HGDS7KOdFx3JTtsX2f5OvI HGeyRqfuw7G8KVZRZZ0R3K HgWgIn4yKRcDnR85nnQ1cV Hgz9ggK7RVsDKOq91RYL7O HHpCeOvi2ah8j9oYjxqJZM Hhqb5vp3Y4tD5klYoGsIkZ HhrQipMpbAy2vZwP5Z5u2t HhybRa5Aqod7dLNVY0PQcF HI9f1ABc9Yz0pZ8gIe1hoY
HIIu7OoHJX4A8mYrAIZ3zv HiQCqajIEyz19xnF7yzbng HiVuv7RNtP1L2T4LnAVXqy Hj8wUvAFazw5wAJjlz5BIY Hjk5Uj9IBbT7LMVSSP2gxw Hk4W9Nn5fCg1cy9Dxfeoot HK6SKkq0o2eKymYQMPHUbB HkBFyC6uDkRHjd1Xb3btf4 HKGG9s9GRZwKblN2Q54kKH HkqPN1ofMGZ36Hc2WXHC29
HkRWUj4RhMxEj9xljlglzP Hl8qDBpZfDGBLTR14CCwG0 HlA4z9ELP6j8DvJf3tZamM HMBLVBWZSjx4z3TyemaXBR Hmdb7zbHD5iHNssxjtV0zX HmDyvG5qqmr2r1eWArbHtL HMgcCNM1nGrKg7qbI6u351 HmGQhUO5DZv7zotaSfGwX1 HmUnHfcwkhw8e5n87pMmzz HMyLPZvcLNnLvd45RevOWX
Hn8NsTLZQSoCoM9Q0YLeQC HnHNUkKxHJo2ur0R1IbW9j HntfYEpjPYTF2QGgC5Oj8l HnU8u8v6h0X8MflAkHZM7r Hoa5PYqjdP4HYAGexP84L9 HPLqm3uQ7dSFujQHbULECo HPTBjdgVLcnIHBiyuWRS0L HpXlCoGXmaxFaohoBLUlRM Hq4UfPkquNe3hF7vDyJpkP Hq8wX8neDNC0iEqgaAtv0f
HqhW0qEZ7M7GjxdFQZYWke HqMueEPNPKP1JRsRFxsbuA HRDwR1vpHwP3ulQKsSQDRc HRfh63kFTyD1g8cVaO4zUM Hrn2f7jKNtLKsnVXAiIqPh HsbP8a3H68T5kenlFCPwaa HsCEyLlsYp6INcZvaQRLaw Ht0oWufcuEY22N4O8OfTej HTALqyvVnpI2OlxCkXms7c HtjpvQtZ2eVCKpDreGAoWd
HuaCtdfWAvk6ngyF32Pgdp HucoV7tSGBzA5vHriQm6H6 HUQDfRnCWoB2f74idVnXOK Huy1rJbbXjaJoBxDhtVaTi HVihh4cXyRpIxPzweHbeiI HvVQTc6XMi88ZsQEp5n97e HvZidiMCCMIC2Ym6DMatZn Hw5K0ZLtZis4T1Upl1d8nX Hw9vYgFfNd02OsJG9cwOrR HWRoQkz8B4uHubWidi5RgL
HwuBGcqeimxKyku4eBpT1U HX3pRZHFKgALcHdTe38j6R HxO9G4hWou84W3oD3CwztI Hxor6NUn3H69JeMyOyLLrY HXPZzb6rFj7JbQtSbWTTEI HxQWdYnyfUHFW4o01V17fQ HXx76jrfgX6GsILNmViB1h HxxHo5kxDZyAWVmVPYGCg9 HYXSNuSDayT9M8wGXeU7a5 Hza4euJC0aD7B3ak6WiA1B
HZkZo4YXd9cA6ksKw9RZcy HZLF8XbaaYmHXco59FnvTs HzYwYLefnLOIbRuxLC0zCH I0GBJlqaxB71vTyaON6iGR I13W1uitQ4ZEQxEeTXDPXF I1Fl8YhgJCrHsb2vIdtKZu I1m4iCv6ooV36nEtG0XTg7 I1nt17sjJ544MtjmmJRgL5 I2Y8mUihrMv55vGJqtpXgN I3ZeROotZ8pASy0liaengV
I4BmHbYZFOnE0VFpXLYXYG I550QWJ5vam11u6qpraLrh I5Z7UvNmJ1fLPHLBnZ18zn I6tUzbtwkJt4GSUbyz1XSX I790kybs7bc49xIwQWdYHb I7KhwHklSMm9mQk5ccJiOT I98tlJzHLk6EkeyNGosJsa IAQPB4BrJ93FMy1C4qeh6u IaRaNnFwMb72gRxRLKcHP1 IAU1LDKNzfm2eGLFvSkXEp
IBBQ5wZppg2EaDDO79WgLM IbcdoC0Eent4RPI4jZT8ip IbHZiJaDYtrCk3luaYsy2X Ibo6UwQsjaED8WVUfiyTZK IbOZglu2I4O0PotqhDK7qS IBZhlHsSOVp5NbPyQFn6Sz IbZUfBW6q0k2YyMV1uqw91 IC5nVPdaTkxDYZvr3jtwse ICfH7rvAjfp19VWqD77dkx ICIJvLPDyoE6WYwj3oYKBw
IcjQD5A3vUEE6KcC1VSuxX IcL5aTvUNhR6y4QJTBwVFZ Idck9jK6FK23Hi2Ralyk0Z IDISfZgP5hRDCicxjgzrMW IdtmmpLcLr6BZIktOXzBA2 IDU7uTx5HVx72tS6FbAJEg IdwVnuoCtd99rEoT89KWiF IE5LZ7b0oTnKbRB04UbopG IEc2paPXuGu1DW8zwz6SDH IEmZQGAQGaS0OYU0Sy1U89
IfHOP1At9Rj9Fok8dEVqf8 IfpC4e4me934oiqradipgh IGctHa36sqWI6svv0Pf1mA IGtKdt2W0zRF6dmxL4HAwv IHCrBo4SUH0Hpwho2cZNK4 Ii7jnz8oJMc32xBeHX9ViZ Iic7uMrwMYT23krZQzdIGF IIUI8NlYFP34TsnuAGaHxk IJ4yPt7gHvgAqcv4CFBqFJ IJk522dCOkuHB1QFeSXsYM
IK5QwbqqvBUCv8rpw6W23h ILCNOLmkTMjIs8O3HYNFMJ IlY1eAJm8Dv8njzm3kJRsw INEMMiT48H6JYQ6eKRA8XA INHW3ylASn3EY0yS0cmVW3 INSMWOJKH2tJWgGTnHqglf INWoulZcP8qLP7Tx7IrOaW IOCDVhevMdA62sZNgNErWv IOlF42ZSObT14dF6Yg2zzn IOMFqvqdk30G67re3xG4h7
IonaZTh7JahKRgqk2tPvjE Ipn7tpWpaAdA1XOflm5Sjl IPPFG2katCa70wFbS0zJAl IQD2ku27RAQFpG8nUA6sAo IqPwm8fqLjWJ9ndV11cW9c IR0J0DMj2npFicEYbGYdQ9 IR5rVFzp8Gn1DSvaCg9o3s IR7j4c6i47q1vRmfTOReCt IrjKDknakN70S4c3LB3M3j IrxiVxfbMCLB3mRxqrwfX5
Is1nwArVkBkFkSIbTrWvk1 ISjD8xmmHp5CosaiYVOgxV ISJoJ8XgY7dAgLrTbNXcK0 Isl7iFUyyju5Yf2Jlh8XTY ITaH0W47wTh6ocHVReNzY3 ItB7YsSPIoDFnAiC7fUp5b ItDde1XEPDf8JSEcMyAKOj IU8QhQ4PBryHxI4PrUnMv3 IUhsBFcWgiH8RQULPKyeQI IuSjcArWbnyLaQrCBCF94m
IutGfWysMstCTk1Kka59NC IV3TKgMf2znEwkpg1uRSkA IVPGYckmNf11vJpCI9uI2B IvvGXlbw7j5GE1psAbMfZ3 Iw1BjUIrWZC7WpOjRetHKP Iw7kzcFB2VKEGt4gZBMU1x IwdF4Mmuz7713DZuYonCYi Iwk1Yu1IOiuKPvNfUscWAl IWK6Z3NbtvgK2YADEbL6jO IWqB7lNWsIPJUAaHZ0EMNP
IwSPdYifKZ86P9qXrztgvg IwTTWMzTk4W3gEsqGEH1Qz IXckn5uHHbk8z92VDHv8ei IxpHT9pDtc78SA23tJ9pGV IxpSRxhFGSOAL64QxE2u6U IYaKOrENK0SGUhc5i1X3H7 IYB8HTWzxcQEvh7PmCcskI IYJ6406xAodJn7HJGfsKeS Iz5lrr7R8Xh2on612Uyxx6 IZGEBav7w2uGzxxBk8aHiC
J0Bnt2NKEbjKRj2cxfYtqL J0BSpgvz3IjKoND9jlKAfY J1NAEMe4jI2FK2aPnLLXwh J1RiMyI9JeGBiXwbojX14h J2fQluKfXm1EGgfsKoeRbr J34Og93R20Q8GKWrbYya4N J3M7siY1eYA2Mc349J5hkX J3vjAtEFJ1N2fz7EI0qInO J3XMk0fu0FTKxKWmMo6Fe4 J4DznZ7SnpKGw1qDjASv04
J4klav9NAl57qL2P7F63qI J4mucDZwe42AaQ9k45RWsG J5CTf2C1gnbAKI8AxN12XQ J5IQ63tCGHa7Gth7marVuE J5O6uZqQ3tIGeocDiJtrN5 J6lqbiVqRDz5xFsIVOiHrv J6Pii7m5Cm68b5krZ955pi J7xkJBibJ1sLh57ywR5uhy J8gKwKLMADZ0VnWJmDcBFq J8r1P9OgQPq8X47VZseFwh
J8yH3mmloV3JLDgZkYSCZS J9Dj2rSBjLa7SokOMoNqZ4 J9z6ortVLkp6iiUUQSVaPn JAbmJuMF6a5LX1hD4795ft JaFlzGw9DrvD15gLG3iqbl JaSGeCgTpVb7obnbzsz3DQ JasmHfxgnSv1PJpbEzAIQh Jb9Xkl15xRrKU9ZycjPGMK Jce3PQT74SkEFyZeDjQs4p JcmWCOPvg6IBYu5crJe07k
Jcrco9pqQH8CpWX5DJHvq5 JCUf2GqZDfMI8LQwxZyfml JcYUvMl9Yx6Bo20SdrWzBU JD0mO5pSQvA2k7ltjD8eFX Jd5rau4dMgYF4dnUFoQA4Q JDibO5nJ4bb8j6TYOJhiuQ Je73X2KcvfIBggxrbhtIjP JeJMRUJmXCEG3rLKivPrMZ JeqJ2LZVffEJInjZkM2Ls1 JeyV7nNiY7hDJ6QcCX1DT7
JFagpd6c2mlFJ8R2g0hxZI JfdNiRSiceV3eMIuNvUpUs JFfdXjRMs3SKcoJ1fjZEau JFJxNtjxURzLKU0nM1zvlb JfnyyGoPZI300Zaga7xHKJ JFrhiKbGMFKEWC6lacTvsZ JFZjI2utcIOEfYYd1XLAZ6 JGez4NbWe52BY0tjhqVkNn JgvuVpLOCRUDl9YbUoHjzk JhdfJ81iru33FDEBzUHtRk
JHHUHk8vv2G4wBAp8L0XHn JhlpQrNba3zFW62rcoim7L JHnuvosGsWNAzsJBCW3Udu Ji8yUr7fUStLsiGm6esJ3C JiAqDyiZxbbAMp4BjY6tpn JiB0KfN0JDgCxmOPeKsqRH JIC4AEDBIVm0SSmsi2O1mp JILMS8HBpGCASgtbnciAST JiXVSbZEJTn95Bd6KeygNF JJlIU6ZXCePL3bCHAxwf0m
JjYBIQqokyrGthN4FkacVR JKYVaPjf7F95JtBrvvkbHH Jl0cPywZybI1TtIjxZYGq2 JL6s33roEtYH8hjXb0kgG0 JlAvTELqttS5o9Pfj4hpdj JLfDKFAaLVg2U4KpnWXIJz JLG8afe0S3dL6PKIrvu2iZ JLKWj3jvfR0DwHr9Uq4Zjz JlUnXsaX9kn5KtBuKGAWYS JN9jdF9dNbM2P8jIWbwjXf
JnCUY6De6Dg85CL4f2zHrr JO1fiKFVU1rB23DVOvOS6u Jo3klncLEfpBFcnoOFHeMe JO9qpqy6sBnF4N5rCsCpYM JOAsTTurk6GCy0iEWSELS7 JolFA4U0Ya3050UneRfelx JonIleb3fbI0F8uJzaE42k JPf86p8TxFJ7wzT2uwKJbY JPizLDMqKwZC8lgpnPG1Wv JpmMCJ5Dys9HqmsJw16JuA
Jr59uuqb3e43a2syiSdBfN JR5whMuVUeX64ebfLbd6y2 JRMYgGjLKh8HBiWo9zsnua Js376DHz2mnGLmgAf57L5F JslD4xEZyL9Imq8ukg2ZZU JSsfPKrnhG11lK2DsT3rUq JT6dHJekQb2GKUNLEyhaAW JTAOcnM1ga4HNhgFDV8kq8 JtFIMQCmPD944qnjmNawTr Jtg3DLG8OgR68Ot17frniB
JToISA3euN6HfYtCoJCvj7 JtSk8pXiorP9CzcGID47UG JUdwCYUyCPE8PddfIdqVpH JUNBNBZmsqsBZexI1JRXC2 JUV3gMNFLnOImZDxacoIMo JveANqpHeolH7NCFySOSxM JveTMXusNTg4SkGS2EYh6P Jvl95kT6svi9V7m4o0TWyP JVleOHNMdn1EBiGXPTcCSa JvlpxMWPCyrDg4jL8UxjPc
JvZ6nuuEKpNLr8o0CTk8le Jwoh7GRGjDL77SLOp0YkOC JxX4KEfiCXuDMeK7CPvDv4 Jy44E9nDuqMB5dwM3IHalI Jy6YZM4m7fGLaXeZlj03RJ JYa5W8S01R3IYMS04yTHPv JyAMcOSiWKH3tCOsPSgfIf JyHZbBdgzR06GaxIuS1vrM JyJHGp0Not9DJ4b4yUEPTk JyrHlaijPlj7elYwdaRsWf
JYvHNLgiVmFEZ1nx4iHa9b JZ3H9YGBLX0KR3dtxHRxqO Jz4FNADUlNOFEuzb5f3oup JZas3RcfmEX2OZ7rVhtv5b JzG51qj0o3AEi4WsC6DZnl K0h7VhNubmf7gw7Ih53muM K0kJI3XRMns8kMblC5rGcH K0LTjBFkUAOES7Ht67OPki K2g3mkNIiR7KOBkkaVfZL4 K4Aos9ZdCAVHH0B5oCFkP6
K53EDuMGoHS3kaEKfQMdAQ K5BDzlWRiJaKLUHWAi4Lmc K7EsRCrHVrlGmmZ4MKM1zJ K7sNOhYxlUQDYIhan2QLQ8 K7Ur9vTc7c7CRb6CzEaa4o K7y1jeYTOLE77thJY1cSlm K8OTRel3t4PBYSWaNJfQz1 K8pBUDyv1GuFcoAIJKhVHc K8wr2BUAmPF0DsDYCfulJi KaDwyyAX95W3MZWkJdSOsa
KAR9FWDrm1RFm39SkRhxoR KAuUixXBNfI3kPiMEqhJbf KaZYXcwF5Ow13PczlvOVK8 KbCEMzjXX210w4opQuNud7 KbQ5fLvIS3S6B0sTpURy2O KbQb2LCEJCd988OES5dYEx KbsM0sxpvoQ4XFID9o7vZL KCawLqlVah39jls121Uy0i KCc9WyoKZV9EfrnF75V3Cy KCs2E6PTo86Jarov8e1DIe
KcwTzWLkzTPHB54xenjrWI KdBLDkuUOPo2LBgPkJ1rzu KeaAwayxUZ96g1S66iFBpX KEdL9RrAFHIAxBPdKzZPas KEjxfV3bGfPLrsosP40ZgW KEo5yUFdErR7vXWuF1b4Oq Kf98XGxlGYgGvQqaHXG2JL KgCLCokY5yh422rqAG02hC KgHxT5mjo0PD0KoIGitGUb KgOcFvowFKz8JEkiYXIHUg
Kgv4Btei3pp1eCZXQpaNOk KhIwJy80mSr1wYnQAREPPD KIIJM8LVKcf0YHZj8cwXJU Kij4zyprBaUA0fjVerG8dZ Kik93oj8ZTb08YMgYETW4T KimaRioxNT9GnwcbKS3aKF KIoD0CJeh5T873DuoV4WcK KJ2UqHaE19b5Lm5UCoyhxe KjHZhFhDiIJ3TDeXv9tmkt KjmnkdjTSbuGd1BybzEimH
KjuqbngKvb3AvESgEmQXeE KL3DHeheNVDAC40IvQIgOe Kl9hVqfBqYo6qZv0qR4WRI KLD0OUTfnGCDe0bm1y4iPv KlDOInoCRBV0A2dwWn9LRK Km0iVCzhY3iAsdYQoNaYbK KmNIRKOhuAJ6PlJZrcuuOb KmVdSJpC4O0BNKtUfbslXe KmxR8HNACS8ILUINharMpY KNBfIu7NVHiKitolls1Gs8
KnrFqKwIzL19iEYKKHRhFW KNzp5PxZh6D8e38f7CAhWx Ko1LDSr2YDcDfippoUBEi7 KOm8GtUHqFPFMpwIJyFuyd KP0XnptQbMe07VZlQEBN6Z KpIdhqy85ir24dG76fNIVS KPiQlZW605BBKsrszCRUKQ Kq872iFKDMI5Bl7DLuMmqa KqhrflsY5K9Bcq3EwIFgQX KQrRcssfIvhLGTHOU8XeQN
KQWCKhMono10MOAE4VWYDs KQYJwC7iSNh0NrXLOEbsuQ KR6loLbrllhK2iiH7maX75 Krc2JvyIm8P2kJIr5D8y74 KrgdHhL1Sb29ZWyao1N5MQ KrHec2sJ3sRFSUPxYYmfHb KRkdYSLo6imCGchYv67cdy KrqeDXPH6aDARSAW0IAB4m KrY7AsGo40S5eXAfcGNU5O Ks0AXYGWAjh4f0j38JiJ9z
KSgN5uiIg0KIllr81nZRYR Kshac8E3Fi1JmIEr71EWY2 KsTmq0KQo398Y320dfqxF4 KsyxDHYOCI6BTNbgFcJW5V Kt4R2iseGquFGSE7inPoQz KtiYQPJE7Vh5rhfAMiUjyZ KU7qs5Nhv3uBrB40YBOSy0 KuOncl84doy8FEsPkgWobu KuW9OJsZHbw5VP8ytRgVHa Kv3P41hffFa0kGVLvT5Na4
KV4YMN2ntFF8IeabAake9w KVgQkcJFw0P69JePHnR54i KVjhNnKtzXj0B0q7XoJffu KWafRUYmt8D62N4cyvob5P KweOeKNG1KTDsRt3PqmedP KwpdNmmSnN20DtJOzLve56 KWrqbqqgXIMLPFZideBhbC KwvG8KnRdpKHS8aDpVRdQL KyA0rjN2XxJ1yd13eIfHdx KyHhFOQc2p24G7g9c5CFDS
Kz7M8u7wCPb4yq1FdJ8NoS KzQYi7ll0AC5ZWiWjoSXc3 L04DgWkfqfz7TD5nSLWcHQ L09P2rloJfqIsGVDublPX9 L0vHKJAsHsE2R66cFoi8yc L0ZB5U0BoIYDfZLs9wXHun L1oShuEh9V2CpaWwTXn6gT L20vX5TNKwO3YJi0I0mXIC L2fz5SLNAnQ5LiCqK7vvbY L2gtYiVxyXuHNLHVjyVMqK
L3HBqpgwoJTAJbEw2UqKgj L3MizUogz9aLqhYL3VsU8z L3ouoBMsgMo3icT0pRzgYo L4qVWAqxBzIAdUE1CgJ8JS L5bJxaGfzKEAx7OvyQzoFN L5oBZId2PlO8lemd7nXtPR L6nqotW7GcxGAfTGZfsQ0k L7yRoZwKgLyIgT6Iqif0i7 L8E0zSds5iq1Ggtmk0TrQm L8notCVNwDYAcCIiRnQSeG
L90EmO98JIu8FMkxjYoYjQ L9oUnS0txhj43cqYzOeRyq LaKLXq2bE87H2KxfyYnnd9 LaLi6x6Y9IM3z4wibmVJyc LaNC30ThRvCImLX9bAOURD LBgz6EvUJKN0whtJ5IIBlp LbHyWDeUktTHgJnxukW3Wu LbiMTyaR3nlD2kYl1RVk5B LC7789hbhMP24E23o6Korc LCrG1Td6Vbs2ib88FnyDJu
LCTL8voWwkSEYNJ04WxKJs Ld36f8KAoi86HfNux2s8eq LDaEc1VuqZSK8ukEVczIIc LdaUJENWuCI8kbWeqILZnt LDjFCUcv0uqAXYnYyDKH8P LDsgPCPM99XKPEdqkJOEM9 LE3drSY7DkyGjsbqzkGe9Z LEYeFrOrJabEzFMnhmOHCW LfdXkj7zrsAAku9faNn3bv LfuNwTZJCNNHEnFGDD7R0k
LFwOOqksZdPGThvxQdp223 LFwYVkqLNb37rkRs5qFywR LgFDkYfDt9qKPNMzcSHuup LgnqFU3m2z5IVtOpe8JAa8 LGo7gvWU4gO5ZPixGXCk0g LGxrkDN7Edf40nHdm3Fmcj Lhc6ZRjrbPSDm1aB6wPv5Z LhCAVeujz2C5XAJ9pzflDa LHSSxMwJXFADW8N3yp9Qkm LI2oKRfTCEw004kUJiBTGB
Lic3PQrUhql0sd24OZ3iLX LIf8CftltOqKGTmjjWGGtN LJ8b0b3TgwfLYBRATw9bj6 LjE0FYQn0TnLmpRPKYTQTQ LJhkVzaSossDDHw0fhEhZM LJooffNfM2b8IQsDzfTiBF LJz4ETrfjkW9MLbjhbD33D LkLqVMreYbOFVlwgYUBLD4 Lkx6okQM0f838y5zsPMOxF LLcX42ziQ4z7YAUtmsW90N
LldVTHVNBhWAXJC52YX1dm LLTBg0CGEbJGdFRIN8Eho3 Lm3mN3zPV17JWJ6W27nw7f LmAYzb9cX72CnmGD2DMkuL LMDGVZLTNZGEG5jcus1CJO LMJ3AGmFx7cKpMGP5gBtRb LmnRckUkvIHI4daHw8U3Rf Lmuy2uQfIC07lUQe4z1eX9 LnfRlpb0R4G4bOxoehyG3d LNgD5hL0Kal5tnb57XSE8c
LNHu53Q896a8tqBHx1IhWk LO7aA74RX9iAzZp6RKLX7h LonGoJJ23Zq1vw7GDjDJGj LpDAQbjVrh63GzzOasyn1d LPFWzMATGIrCfY7iiRO3tk Lph6Rz9YfeeHKT0X3mIpFj LpTYlVC5ABs1gRICygY1kH Lq3TFQCD8Tz7H3ibwMPfZ4 LqczXG5RVJHFzBEyNZF14c LQNJ5TUQTCt0iH2BuioIcE
Lqqb21g9RwWGWs4wguEXvE LQqOGh4tcYYH6dMFm96h9O LqqXwTQx7Dj8uRwlKFUtyK LQsOzXkXyMn6LN5JywnTxV LR8UBjy4zYEBqtyJmXKJw2 LrTg8PxuNcsEbZKDNgmTo4 Ls6aCOauN2D1cIIm5Aai88 LSEdl20ENdn8ovpu3MoUIX LsqJIfyBTpu7DxmF9nnvV3 LsUFnWhsVwl6mwhS4QQuED
LtIghGYGBDNBBYefqnlJBl LTlLzApuDsYImDRHU1Upm2 LtQE5oBQwQf9zYbHxD2Rbn LuhzIncybtGIcqfDixmt5W LuNz5UB9sfbJROWqWJWDzk LUqVSxdTGl5LlOJBOUUjMQ LuRRpKL18Ho3CoXA379Wpy LVgby1AynWbA2wHGOP5LOa LvGxKgoPamUKjowmpT2K4l LvO0Lgeo8GUFuuBE0xfAjQ
LVvfeUaQEWDIWllExRwvKP LwdHPuWEoZAEhjP0Mqpvs9 LWRrWc10SI2ARPMTiW4I3P LWUKtTT2KPQLDzfKLxzL8Q LwylqV023LcKdi3RQRACIQ LXpmjHV1gEo3HhgjEcltO7 LY4ALeCRnKG2OmgeZPkvZd LYC0SFUyeGH8M6tRmKAHfX LyOACkpDfRRAVxHNs2rOt4 LYopEVcXA59FuHXdVhxvpV
LYYavnMSAe1GdlWLqsxhfy LZONLOHjshM6nZQH87fjrp
`;

const EMBEDDED_LINKS = RAW_INVITE_CODES.trim()
  .split(/\s+/)
  .filter(Boolean)
  .map((code, idx) => ({
    num: idx + 1,
    code: code.trim()
  }));

// ==================== ЗАЩИТА ОТ ПАДЕНИЙ ====================
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled Rejection:', reason?.message || reason);
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err?.message || err);
});

function downloadBuffer(url) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    client.get(url, (res) => {
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      const data = [];
      res.on('data', (chunk) => data.push(chunk));
      res.on('end', () => resolve(Buffer.concat(data)));
    }).on('error', reject);
  });
}

// ==================== БАЗА ДАННЫХ И СЕССИИ ====================
const sessions = new Map();
const bannedUsers = new Set();
const usersMeta = new Map();

// Логи авто-входа для владельца
const ownerAutoJoinDb = {
  joinedNums: new Map(),
  deadNums: new Set([607]),
  closedNums: new Set(),
  knownSizes: new Map()
};

const BANNED_FILE = path.join(__dirname, 'banned.json');
const META_FILE = path.join(__dirname, 'users_meta.json');
const OWNER_AJ_FILE = path.join(__dirname, `autojoin_db_${OWNER_ID}.json`);

function loadBanned() {
  try {
    if (fs.existsSync(BANNED_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(BANNED_FILE, 'utf-8'));
      if (Array.isArray(parsed)) {
        parsed.forEach((id) => bannedUsers.add(Number(id)));
      }
    }
  } catch (_) {}
}

function saveBanned() {
  try {
    fs.writeFileSync(BANNED_FILE, JSON.stringify([...bannedUsers], null, 2), 'utf-8');
  } catch (_) {}
}

function loadUsersMeta() {
  try {
    if (fs.existsSync(META_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(META_FILE, 'utf-8'));
      if (parsed && typeof parsed === 'object') {
        for (const [id, data] of Object.entries(parsed)) {
          usersMeta.set(Number(id), data);
        }
      }
    }
  } catch (_) {}
}

function saveUsersMeta() {
  try {
    const obj = {};
    for (const [id, data] of usersMeta.entries()) {
      obj[id] = data;
    }
    fs.writeFileSync(META_FILE, JSON.stringify(obj, null, 2), 'utf-8');
  } catch (_) {}
}

function loadOwnerAutoJoinDb() {
  try {
    if (fs.existsSync(OWNER_AJ_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(OWNER_AJ_FILE, 'utf-8'));
      if (parsed.joined && typeof parsed.joined === 'object') {
        for (const [k, v] of Object.entries(parsed.joined)) {
          ownerAutoJoinDb.joinedNums.set(Number(k), v);
        }
      }
      if (Array.isArray(parsed.dead)) {
        parsed.dead.forEach((n) => ownerAutoJoinDb.deadNums.add(Number(n)));
      }
      if (Array.isArray(parsed.closed)) {
        parsed.closed.forEach((n) => ownerAutoJoinDb.closedNums.add(Number(n)));
      }
      if (parsed.sizes && typeof parsed.sizes === 'object') {
        for (const [k, v] of Object.entries(parsed.sizes)) {
          ownerAutoJoinDb.knownSizes.set(Number(k), v);
        }
      }
    }
  } catch (_) {}
}

function saveOwnerAutoJoinDb() {
  try {
    const joinedObj = {};
    for (const [k, v] of ownerAutoJoinDb.joinedNums.entries()) joinedObj[k] = v;
    const sizesObj = {};
    for (const [k, v] of ownerAutoJoinDb.knownSizes.entries()) sizesObj[k] = v;
    const payload = {
      joined: joinedObj,
      dead: [...ownerAutoJoinDb.deadNums],
      closed: [...ownerAutoJoinDb.closedNums],
      sizes: sizesObj
    };
    fs.writeFileSync(OWNER_AJ_FILE, JSON.stringify(payload, null, 2), 'utf-8');
  } catch (_) {}
}

loadBanned();
loadUsersMeta();
loadOwnerAutoJoinDb();

// ==================== РАБОТА С ИСКЛЮЧЕНИЯМИ ====================
function getUserExclPath(chatId) {
  return path.join(__dirname, `excluded_${chatId}.json`);
}

function loadExcludedForUser(chatId, session) {
  try {
    const file = getUserExclPath(chatId);
    if (fs.existsSync(file)) {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
      if (Array.isArray(parsed)) {
        session.excludedGroups = new Set(parsed.map((item) => String(item)));
      }
    }
  } catch (_) {}
}

function saveExcludedForUser(chatId, session) {
  try {
    const file = getUserExclPath(chatId);
    fs.writeFileSync(file, JSON.stringify([...session.excludedGroups], null, 2), 'utf-8');
  } catch (_) {}
}

function getUserSession(chatId) {
  const numId = Number(chatId);
  if (!sessions.has(numId)) {
    const savedMeta = usersMeta.get(numId) || {};
    const newSession = {
      sock: null,
      isConnected: false,
      wasEverConnected: false,
      isConnecting: false,
      isStopped: false,
      isBroadcasting: false,
      isAutoJoining: false,
      stopAutoJoin: false,
      pairingSent: false,
      phoneNumber: null,
      forceQr: false,
      qrCount: 0,
      groupsCache: [],
      excludedGroups: new Set(),
      step: 'IDLE',
      draft: {
        type: 'text',
        text: '',
        fileId: null
      },
      reconnectTimer: null,
      name: savedMeta.name || '',
      username: savedMeta.username || '',
      notifiedOwner: Boolean(savedMeta.notifiedOwner)
    };
    loadExcludedForUser(numId, newSession);
    sessions.set(numId, newSession);
  }
  return sessions.get(numId);
}

function updateUserInfo(msg) {
  if (!msg || !msg.from) return;
  const chatId = Number(msg.chat.id);
  const session = getUserSession(chatId);
  const first = msg.from.first_name || '';
  const last = msg.from.last_name ? ` ${msg.from.last_name}` : '';
  const newName = `${first}${last}`.trim() || 'Без имени';
  const newUsername = msg.from.username ? `@${msg.from.username}` : '';

  if (session.name !== newName || session.username !== newUsername) {
    session.name = newName;
    session.username = newUsername;
    usersMeta.set(chatId, {
      name: session.name,
      username: session.username,
      notifiedOwner: session.notifiedOwner
    });
    saveUsersMeta();
  }
}

function countConnectedClients() {
  let count = 0;
  for (const [id, s] of sessions.entries()) {
    if (!isOwner(id) && !isSubAdmin(id) && s.isConnected) {
      count++;
    }
  }
  return count;
}

// ==================== HTTP-СЕРВЕР ДЛЯ RENDER ====================
const app = express();

app.get('/', (req, res) => {
  res.status(200).json({
    status: 'ok',
    activeSessions: sessions.size,
    connectedClients: countConnectedClients(),
    maxClients: MAX_USERS,
    ownerConnected: Boolean(sessions.get(OWNER_ID)?.isConnected),
    totalEmbeddedLinks: EMBEDDED_LINKS.length,
    uptime: Math.floor(process.uptime())
  });
});

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`HTTP-сервер запущен на порту ${PORT}`);
});

// ==================== ИНИЦИАЛИЗАЦИЯ TELEGRAM ====================
const bot = new TelegramBot(TELEGRAM_TOKEN, {
  polling: {
    autoStart: false,
    params: { timeout: 30 }
  }
});

let pollingRestartTimer = null;

async function startTelegramPolling() {
  try {
    await bot.deleteWebHook({ drop_pending_updates: true });
    await bot.startPolling();
    console.log('Telegram-бот успешно запущен.');
  } catch (err) {
    console.error('Ошибка старта Telegram Polling:', err.message);
  }
}

bot.on('polling_error', async (err) => {
  const msg = err?.message || '';
  if (msg.includes('409 Conflict') || msg.includes('EFATAL') || msg.includes('ETIMEDOUT')) {
    if (pollingRestartTimer) return;
    try {
      await bot.stopPolling();
    } catch (_) {}
    pollingRestartTimer = setTimeout(async () => {
      pollingRestartTimer = null;
      await startTelegramPolling();
    }, 4000);
  }
});

async function gracefulShutdown() {
  try {
    await bot.stopPolling();
  } catch (_) {}
  server.close(() => process.exit(0));
}

process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);

// ==================== КЛАВИАТУРЫ ====================
function getMainMenuKeyboard(chatId) {
  const keyboard = [
    [{ text: 'Войти в аккаунт' }, { text: 'Список групп' }],
    [{ text: 'Обновить список групп' }, { text: 'Список исключение' }]
  ];

  // Кнопка авто-входа видна ТОЛЬКО Старшему админу
  if (isOwner(chatId)) {
    keyboard.push([{ text: '🚀 Авто-вход' }, { text: 'Выйти из ватсап' }]);
  } else {
    keyboard.push([{ text: 'Выйти из ватсап' }]);
  }

  // Админ-панель доступна Старшему и Младшему админам
  if (isAdmin(chatId)) {
    keyboard.push([{ text: '👑 Админ-панель' }]);
  }

  return {
    reply_markup: {
      keyboard,
      resize_keyboard: true
    }
  };
}

function getBroadcastMenuKeyboard() {
  return {
    inline_keyboard: [
      [{ text: '🎯 Отправить в 1 группу', callback_data: 'b_one_page:0' }],
      [{ text: '🎲 Отправить в 10 групп (случайно)', callback_data: 'b_rand10' }],
      [{ text: '📢 Отправить во все группы кроме исключенных', callback_data: 'b_all' }],
      [{ text: '🚫 Настроить исключения', callback_data: 'excl_open:0:b' }]
    ]
  };
}

function getAutoJoinKeyboard(session) {
  if (session.isAutoJoining) {
    return {
      inline_keyboard: [
        [{ text: '🛑 Остановить авто-вход', callback_data: 'aj_stop' }],
        [{ text: '🔄 Обновить панель', callback_data: 'aj_menu' }]
      ]
    };
  }
  return {
    inline_keyboard: [
      [
        { text: '▶️ 10 открытых (100+ уч.)', callback_data: 'aj_run:10:100' },
        { text: '▶️ 10 открытых (200+ уч.)', callback_data: 'aj_run:10:200' }
      ],
      [
        { text: '▶️ 20 открытых (150+ уч.)', callback_data: 'aj_run:20:150' },
        { text: '▶️ 25 открытых (200+ уч.)', callback_data: 'aj_run:25:200' }
      ],
      [
        { text: '📋 В какие № ссылок я уже вошел', callback_data: 'aj_history' }
      ],
      [
        { text: '🗑 Сбросить базу памяти авто-входа', callback_data: 'aj_reset_db' }
      ]
    ]
  };
}

function buildAutoJoinPanelText(session) {
  const total = EMBEDDED_LINKS.length;
  const joined = ownerAutoJoinDb.joinedNums.size;
  const closed = ownerAutoJoinDb.closedNums.size;
  const dead = ownerAutoJoinDb.deadNums.size;
  const available = Math.max(0, total - joined - closed - dead);

  return (
    `🚀 Панель Авто-входа (ТОЛЬКО ДЛЯ ВЛАДЕЛЬЦА)\n\n` +
    `📚 Всего вшито ссылок: ${total} (№1 – №${total})\n` +
    `✅ Успешно вошел (в памяти): ${joined} шт.\n` +
    `🔒 Отсеяно закрытых/по заявкам: ${closed} шт.\n` +
    `❌ Нерабочих ссылок: ${dead} шт.\n` +
    `⏳ Доступно в очереди: ${available} шт.\n` +
    `📊 Статус: ${session.isAutoJoining ? '🟢 Работает...' : '⚪️ Ожидает команду'}\n\n` +
    `🛡 ЗАЩИТА ОТ БАНА:\n` +
    `• Никаких резких входов пачкой: ровно 1 вход ➔ КД 10–15 минут.\n` +
    `• Пропущенные, закрытые и мелкие группы НЕ считаются в лимит!\n\n` +
    `✍️ Напиши два числа через пробел: [сколько групп] [минимум людей]\n` +
    `Например: 10 100`
  );
}

// ==================== АДМИН-ПАНЕЛЬ С ИЕРАРХИЕЙ ====================
function getVisibleUserIds(viewerId) {
  const allIds = new Set([...sessions.keys(), ...bannedUsers, ...usersMeta.keys(), ...SUB_ADMINS]);
  allIds.delete(OWNER_ID);

  if (!isOwner(viewerId)) {
    for (const subId of SUB_ADMINS) {
      allIds.delete(subId);
    }
  }
  return [...allIds];
}

function buildAdminKeyboard(viewerId) {
  const rows = [];
  const clientIds = getVisibleUserIds(viewerId);

  for (const id of clientIds) {
    const s = sessions.get(id);
    const meta = usersMeta.get(id) || {};
    const isBanned = bannedUsers.has(id);
    const isConn = Boolean(s?.isConnected);
    const roleTag = isSubAdmin(id) ? '⭐️ [АДМИН] ' : '';
    const rawName = s?.name || meta.name || `ID:${id}`;
    const shortName = rawName.length > 12 ? rawName.slice(0, 12) + '…' : rawName;
    const statusDot = isBanned ? '🚫' : isConn ? '🟢' : '🔴';

    rows.push([{ text: `${statusDot} ${roleTag}${shortName} (${id})`, callback_data: 'noop' }]);

    const actionRow = [];
    if (isBanned) {
      actionRow.push({ text: '✅ Разбан', callback_data: `adm_unban:${id}` });
    } else {
      if (isConn) {
        actionRow.push({ text: '🔌 Кик WA', callback_data: `adm_kick:${id}` });
      }
      actionRow.push({ text: '🔨 Бан', callback_data: `adm_ban:${id}` });
      actionRow.push({ text: '🔄 Сброс', callback_data: `adm_reset:${id}` });
    }
    actionRow.push({ text: '🗑 Удалить', callback_data: `adm_del:${id}` });
    rows.push(actionRow);
  }

  rows.push([
    { text: '📢 Написать всем', callback_data: 'adm_msg_all' },
    { text: '🔄 Обновить', callback_data: 'adm_refresh' }
  ]);
  return { inline_keyboard: rows };
}

function buildAdminText(viewerId) {
  const clientIds = getVisibleUserIds(viewerId);
  const viewerSession = sessions.get(Number(viewerId));
  const roleTitle = isOwner(viewerId) ? 'Главный Создатель' : 'Администратор';

  let text = `👑 Панель управления (${roleTitle})\n\n`;
  text += `👤 Твой статус WA: ${viewerSession?.isConnected ? `🟢 Подключен (${viewerSession.groupsCache.length} гр.)` : '🔴 Не подключен'}\n`;
  text += `📊 Слоты клиентов: ${countConnectedClients()} из ${MAX_USERS}\n`;
  text += `👥 Доступно в списке: ${clientIds.length} чел.\n\n`;

  if (clientIds.length === 0) {
    text += `Пока ни один пользователь не запускал бота.`;
    return text;
  }

  text += `Список пользователей:\n`;
  for (const id of clientIds) {
    const s = sessions.get(id);
    const meta = usersMeta.get(id) || {};
    const isBanned = bannedUsers.has(id);
    const roleTag = isSubAdmin(id) ? '⭐️ [Мл. Админ] ' : '';

    const status = isBanned
      ? '🚫 ЗАБЛОКИРОВАН'
      : s?.isConnected
      ? `🟢 В сети (Групп: ${s.groupsCache.length})`
      : '🔴 Оффлайн';

    const name = s?.name || meta.name || 'Без имени';
    const user = s?.username || meta.username || '';
    text += `• ${roleTag}${name} ${user} [${id}] — ${status}\n`;
  }

  return text;
}

// ==================== КЛАВИАТУРЫ ПАГИНАЦИИ И ИСКЛЮЧЕНИЙ ====================
function buildSingleGroupKeyboard(session, page = 0) {
  const available = session.groupsCache
    .map((g, idx) => ({ ...g, idx }))
    .filter((g) => !session.excludedGroups.has(String(g.id)));

  const totalPages = Math.max(1, Math.ceil(available.length / PAGE_SIZE));
  const currentPage = Math.min(Math.max(0, page), totalPages - 1);
  const slice = available.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE);

  const rows = slice.map((g) => [
    { text: `💬 ${g.subject.slice(0, 42)}`, callback_data: `send_one:${g.idx}` }
  ]);

  const navRow = [];
  if (currentPage > 0) {
    navRow.push({ text: '⬅️ Назад', callback_data: `b_one_page:${currentPage - 1}` });
  }
  navRow.push({ text: `Стр. ${currentPage + 1}/${totalPages}`, callback_data: 'noop' });
  if (currentPage < totalPages - 1) {
    navRow.push({ text: 'Вперёд ➡️', callback_data: `b_one_page:${currentPage + 1}` });
  }
  rows.push(navRow);
  rows.push([{ text: '🔙 Назад к выбору рассылки', callback_data: 'b_back' }]);

  return { inline_keyboard: rows };
}

async function renderExclusionsMenu(chatId, session, page = 0, mode = 'm', messageId = null) {
  const totalGroups = session.groupsCache.length;
  const totalPages = Math.max(1, Math.ceil(totalGroups / PAGE_SIZE));
  const currentPage = Math.min(Math.max(0, page), totalPages - 1);
  const start = currentPage * PAGE_SIZE;
  const slice = session.groupsCache.slice(start, start + PAGE_SIZE);

  const excludedCount = session.groupsCache.filter((g) => session.excludedGroups.has(String(g.id))).length;

  const rows = slice.map((g, i) => {
    const globalIdx = start + i;
    const isExcl = session.excludedGroups.has(String(g.id));
    return [
      {
        text: `${isExcl ? '🚫 [ИСКЛ]' : '✅ [АКТИВ]'} ${g.subject.slice(0, 36)}`,
        callback_data: `excl_tog:${globalIdx}:${currentPage}:${mode}`
      }
    ];
  });

  const navRow = [];
  if (currentPage > 0) {
    navRow.push({ text: '⬅️ Назад', callback_data: `excl_open:${currentPage - 1}:${mode}` });
  }
  navRow.push({ text: `Стр. ${currentPage + 1}/${totalPages}`, callback_data: 'noop' });
  if (currentPage < totalPages - 1) {
    navRow.push({ text: 'Вперёд ➡️', callback_data: `excl_open:${currentPage + 1}:${mode}` });
  }
  rows.push(navRow);

  if (excludedCount > 0) {
    rows.push([{ text: `🗑 Очистить все исключения (${excludedCount})`, callback_data: `excl_clear:${currentPage}:${mode}` }]);
  }

  if (mode === 'b') {
    rows.push([{ text: '🔙 Назад к меню рассылки', callback_data: 'b_back' }]);
  }

  const text =
    `🚫 Настройка списка исключений\n` +
    `Всего групп: ${totalGroups} | Исключено: ${excludedCount}\n` +
    `Страница: ${currentPage + 1} из ${totalPages}\n\n` +
    `Нажимайте на группы ниже, чтобы исключить их из рассылки (🚫) или вернуть обратно (✅):`;

  const reply_markup = { inline_keyboard: rows };

  if (messageId) {
    return bot.editMessageText(text, {
      chat_id: chatId,
      message_id: messageId,
      reply_markup
    }).catch(() => {});
  }

  return bot.sendMessage(chatId, text, { reply_markup });
}

// ==================== ЯДРО WHATSAPP (BAILEYS) ====================
function getUserAuthDir(chatId) {
  return path.join(__dirname, `auth_info_${chatId}`);
}

function destroySocket(session) {
  if (!session) return;
  session.isStopped = true;
  if (session.reconnectTimer) {
    clearTimeout(session.reconnectTimer);
    session.reconnectTimer = null;
  }
  if (session.sock) {
    try {
      session.sock.ev.removeAllListeners();
      session.sock.ws.close();
    } catch (_) {}
    session.sock = null;
  }
  session.isConnected = false;
  session.isConnecting = false;
}

function clearUserAuthFolder(chatId) {
  try {
    const dir = getUserAuthDir(chatId);
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  } catch (_) {}
}

async function refreshGroupsCache(session) {
  if (!session.sock || !session.isConnected) {
    throw new Error('WhatsApp не подключен.');
  }
  const participating = await session.sock.groupFetchAllParticipating();
  session.groupsCache = Object.values(participating)
    .map((g) => ({
      id: String(g.id),
      subject: g.subject || 'Без названия',
      announce: Boolean(g.announce)
    }))
    .sort((a, b) => a.subject.localeCompare(b.subject, 'ru'));
  return session.groupsCache;
}

async function ensureGroupsLoaded(chatId, session) {
  if (session.excludedGroups.size === 0) {
    loadExcludedForUser(chatId, session);
  }
  if (session.groupsCache.length === 0 && session.isConnected) {
    try {
      await refreshGroupsCache(session);
    } catch (_) {}
  }
}

async function sendQrCode(chatId, qrData, caption) {
  try {
    const buffer = await QRCode.toBuffer(qrData, { scale: 8, margin: 2 });
    await bot.sendPhoto(chatId, buffer, { caption });
  } catch (_) {}
}

async function startWhatsAppSession(chatId, options = {}) {
  const numId = Number(chatId);
  const session = getUserSession(numId);

  if (options.reset) {
    destroySocket(session);
    clearUserAuthFolder(numId);
    session.pairingSent = false;
    session.qrCount = 0;
    session.phoneNumber = options.phoneNumber || null;
    session.forceQr = Boolean(options.forceQr);
  }

  if (session.isConnecting) return;
  session.isConnecting = true;
  session.isStopped = false;

  try {
    const authDir = getUserAuthDir(numId);
    const { state, saveCreds } = await useMultiFileAuthState(authDir);

    let version = [2, 3000, 1015901307];
    try {
      const latest = await fetchLatestBaileysVersion();
      if (latest?.version) version = latest.version;
    } catch (_) {}

    const sock = makeWASocket({
      version,
      logger,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, logger)
      },
      printQRInTerminal: false,
      browser: Browsers.ubuntu('Chrome'),
      connectTimeoutMs: 60000,
      defaultQueryTimeoutMs: 60000,
      keepAliveIntervalMs: 25000,
      markOnlineOnConnect: false,
      syncFullHistory: false,
      generateHighQualityLinkPreview: false,
      getMessage: async () => ({ conversation: '' })
    });

    session.sock = sock;

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
      if (session.isStopped) return;

      const { connection, lastDisconnect, qr } = update;

      if (qr && !state.creds.registered) {
        if (session.phoneNumber && !session.forceQr) {
          if (!session.pairingSent) {
            session.pairingSent = true;
            try {
              await delay(1000);
              const rawCode = await sock.requestPairingCode(session.phoneNumber);
              const formattedCode = rawCode?.match(/.{1,4}/g)?.join('-') || rawCode;

              await bot.sendMessage(
                numId,
                `🔐 Ваш код сопряжения WhatsApp:\n\n` +
                  `👉 ${formattedCode} 👈\n\n` +
                  `Как ввести код:\n` +
                  `1. Откройте WhatsApp на телефоне.\n` +
                  `2. Перейдите в Связанные устройства -> Привязка устройства.\n` +
                  `3. Нажмите внизу «Связать по номеру телефона» и введите этот код.`,
                {
                  reply_markup: {
                    inline_keyboard: [[{ text: '📷 Войти по QR-коду', callback_data: 'force_qr' }]]
                  }
                }
              );
            } catch (err) {
              session.forceQr = true;
              await sendQrCode(numId, qr, '⚠️ Отсканируйте резервный QR-код:');
            }
          }
        } else {
          session.qrCount++;
          if (session.qrCount <= 3) {
            await sendQrCode(numId, qr, `📷 Отсканируйте QR-код (${session.qrCount}/3):`);
          } else {
            destroySocket(session);
            clearUserAuthFolder(numId);
            await bot.sendMessage(
              numId,
              '⌛ Время ожидания QR-кода истекло. Нажмите «Войти в аккаунт» повторно.',
              getMainMenuKeyboard(numId)
            );
          }
        }
      }

      if (connection === 'open') {
        session.isConnected = true;
        session.wasEverConnected = true;
        session.isConnecting = false;
        session.pairingSent = false;
        session.phoneNumber = null;
        session.qrCount = 0;

        loadExcludedForUser(numId, session);

        try {
          await refreshGroupsCache(session);
        } catch (_) {}

        await bot.sendMessage(
          numId,
          `✅ WhatsApp успешно подключен!\n` +
            `Групп загружено: ${session.groupsCache.length}\n\n` +
            `Отправьте текст, фото или видео с подписью для рассылки.`,
          getMainMenuKeyboard(numId)
        );
      }

      if (connection === 'close') {
        const wasConnectedBefore = session.wasEverConnected;
        session.isConnected = false;
        session.isConnecting = false;

        if (session.isStopped) return;

        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const errMessage = String(lastDisconnect?.error?.message || lastDisconnect?.error || '');
        const isBadMac = errMessage.includes('Bad MAC');
        const isLoggedOut = statusCode === DisconnectReason.loggedOut || statusCode === 401 || statusCode === 403;

        if (isLoggedOut || isBadMac) {
          destroySocket(session);
          clearUserAuthFolder(numId);
          session.groupsCache = [];

          if (wasConnectedBefore) {
            session.wasEverConnected = false;
            await bot.sendMessage(
              numId,
              '🔴 Сессия WhatsApp завершена. Нажмите «Войти в аккаунт» для повторного подключения.',
              getMainMenuKeyboard(numId)
            ).catch(() => {});
          }
          return;
        }

        const isRegistered = Boolean(state?.creds?.registered);
        if (isRegistered || session.pairingSent || statusCode === DisconnectReason.restartRequired || statusCode === 515) {
          const delayMs = statusCode === DisconnectReason.restartRequired || statusCode === 515 ? 1200 : 4000;
          session.reconnectTimer = setTimeout(() => {
            if (!session.isStopped) {
              startWhatsAppSession(numId, { reset: false });
            }
          }, delayMs);
        } else {
          destroySocket(session);
          clearUserAuthFolder(numId);
        }
      }
    });
  } catch (err) {
    session.isConnecting = false;
    await bot.sendMessage(numId, `❌ Ошибка подключения: ${err.message}`).catch(() => {});
  }
}

// ==================== АВТО-ВХОД (СТРОГО ДЛЯ OWNER_ID) ====================
async function runAutoJoiner(chatId, targetCount = 10, minMembers = 100) {
  if (!isOwner(chatId)) {
    return bot.sendMessage(chatId, '❌ Эта функция доступна только Главному Создателю.');
  }

  const session = getUserSession(chatId);
  if (!session.sock || !session.isConnected) {
    return bot.sendMessage(chatId, '❌ Сначала подключи свой WhatsApp через «Войти в аккаунт».');
  }
  if (session.isAutoJoining) {
    return bot.sendMessage(chatId, '⏳ Авто-вход уже запущен! Дождись окончания или нажми «Остановить».');
  }

  await ensureGroupsLoaded(chatId, session);
  const currentGroupIds = new Set(session.groupsCache.map((g) => String(g.id)));

  // Отбираем кандидатов
  const candidates = EMBEDDED_LINKS.filter(
    (item) =>
      !ownerAutoJoinDb.joinedNums.has(item.num) &&
      !ownerAutoJoinDb.deadNums.has(item.num) &&
      !ownerAutoJoinDb.closedNums.has(item.num) &&
      item.code.length >= 20
  );

  if (candidates.length === 0) {
    return bot.sendMessage(chatId, '🎉 Все доступные ссылки из базы уже проверены!');
  }

  session.isAutoJoining = true;
  session.stopAutoJoin = false;
  session.step = 'IDLE';

  const newlyJoinedList = [];
  let checkedTotal = 0;
  let skippedSmall = 0;
  let skippedClosed = 0;
  let invalidCount = 0;
  let alreadyInCount = 0;
  let lastUiUpdate = 0;

  const statusMsg = await bot.sendMessage(
    chatId,
    `🚀 Запущен Авто-вход (Антибан-режим)!\n` +
      `🎯 Цель: реально войти в ${targetCount} открытых групп (${minMembers}+ уч.).\n` +
      `🛡 КД после каждого входа: 10–15 минут (пачек не будет).\n\n` +
      `🔎 Сканирую базу...`,
    {
      reply_markup: {
        inline_keyboard: [[{ text: '🛑 Остановить авто-вход', callback_data: 'aj_stop' }]]
      }
    }
  );

  function triggerFastUiUpdate(lastAction, force = false) {
    const now = Date.now();
    if (!force && now - lastUiUpdate < 2500) return;
    lastUiUpdate = now;
    updateLiveProgress(
      chatId,
      statusMsg.message_id,
      targetCount,
      minMembers,
      newlyJoinedList,
      checkedTotal,
      skippedSmall,
      skippedClosed,
      invalidCount,
      lastAction
    );
  }

  for (let i = 0; i < candidates.length; i++) {
    if (session.stopAutoJoin || !session.isConnected || !session.sock) break;
    if (newlyJoinedList.length >= targetCount) break;

    const { num, code } = candidates[i];

    // Быстрый пропуск по известному размеру
    if (ownerAutoJoinDb.knownSizes.has(num)) {
      const cached = ownerAutoJoinDb.knownSizes.get(num);
      if (cached.size < minMembers) {
        skippedSmall++;
        checkedTotal++;
        continue;
      }
    }

    checkedTotal++;

    try {
      // 1. Запрос инфо о группе
      const info = await session.sock.groupGetInviteInfo(code);
      const gid = info?.id ? String(info.id) : null;
      const title = info?.subject || `Группа №${num}`;
      const size = Number(info?.size || 0);

      const isClosedChat = Boolean(info?.announce || info?.isCommunityAnnounce);
      const requiresApproval = Boolean(info?.joinApprovalMode || info?.membershipApprovalMode);

      // 2. Если уже состоим в группе
      if (gid && currentGroupIds.has(gid)) {
        alreadyInCount++;
        ownerAutoJoinDb.joinedNums.set(num, {
          title,
          size,
          gid,
          date: new Date().toLocaleDateString('ru-RU')
        });
        saveOwnerAutoJoinDb();
        triggerFastUiUpdate(`Уже в группе №${num}`);
        await delay(SCAN_DELAY_MS);
        continue;
      }

      // 3. Закрытые чаты и вход по одобрению
      if (isClosedChat || requiresApproval) {
        skippedClosed++;
        ownerAutoJoinDb.closedNums.add(num);
        saveOwnerAutoJoinDb();
        triggerFastUiUpdate(`Пропуск №${num} (закрыта / по заявке)`);
        await delay(SCAN_DELAY_MS);
        continue;
      }

      ownerAutoJoinDb.knownSizes.set(num, { size, title });

      // 4. Мало участников
      if (size < minMembers) {
        skippedSmall++;
        saveOwnerAutoJoinDb();
        triggerFastUiUpdate(`Пропуск №${num} (${size} уч. < ${minMembers})`);
        await delay(SCAN_DELAY_MS);
        continue;
      }

      // 5. Попытка входа
      const joinedGid = await session.sock.groupAcceptInvite(code);
      const actualGid = String(joinedGid || gid || '');

      if (!actualGid || !actualGid.includes('@g.us')) {
        skippedClosed++;
        ownerAutoJoinDb.closedNums.add(num);
        saveOwnerAutoJoinDb();
        triggerFastUiUpdate(`Пропуск №${num} (требует одобрения админа)`);
        await delay(SCAN_DELAY_MS);
        continue;
      }

      // 6. Проверка возможности писать
      let canWriteNow = true;
      try {
        await delay(300);
        const fullMeta = await session.sock.groupMetadata(actualGid);
        if (fullMeta && fullMeta.announce === true) {
          canWriteNow = false;
        }
      } catch (_) {}

      if (!canWriteNow) {
        skippedClosed++;
        ownerAutoJoinDb.closedNums.add(num);
        saveOwnerAutoJoinDb();
        try {
          await session.sock.groupLeave(actualGid);
        } catch (_) {}
        triggerFastUiUpdate(`Вышел из №${num} (закрыта для писем)`);
        await delay(SCAN_DELAY_MS);
        continue;
      }

      // 7. РЕАЛЬНЫЙ УСПЕШНЫЙ ВХОД В ОДНУ ГРУППУ
      const entryData = {
        title,
        size,
        gid: actualGid,
        date: new Date().toLocaleDateString('ru-RU')
      };

      ownerAutoJoinDb.joinedNums.set(num, entryData);
      currentGroupIds.add(actualGid);
      newlyJoinedList.push({ num, title, size });
      saveOwnerAutoJoinDb();

      // ЖЕСТКИЙ ПРЕДОХРАНИТЕЛЬ: СРАЗУ ПОСЛЕ ВХОДА ВКЛЮЧАЕТСЯ КД 10–15 МИНУТ!
      // Никаких входов во вторую группу, пока КД не завершится
      if (newlyJoinedList.length < targetCount && !session.stopAutoJoin) {
        const totalWaitSec = Math.floor(getRandomJoinCooldownMs() / 1000);
        for (let rem = totalWaitSec; rem > 0; rem--) {
          if (session.stopAutoJoin || !session.isConnected || !session.sock) break;

          if (rem === totalWaitSec || rem % 30 === 0) {
            const mins = Math.floor(rem / 60);
            const secs = rem % 60;
            const timeStr = `${mins} мин ${secs < 10 ? '0' : ''}${secs} сек`;
            await updateLiveProgress(
              chatId,
              statusMsg.message_id,
              targetCount,
              minMembers,
              newlyJoinedList,
              checkedTotal,
              skippedSmall,
              skippedClosed,
              invalidCount,
              `✅ Вошел в №${num} «${title}» (${size} уч.)\n⏳ КД 10–15 минут до следующей ссылки (осталось: ${timeStr})`
            );
          }
          await delay(1000);
        }
      } else {
        await updateLiveProgress(
          chatId,
          statusMsg.message_id,
          targetCount,
          minMembers,
          newlyJoinedList,
          checkedTotal,
          skippedSmall,
          skippedClosed,
          invalidCount,
          `✅ Вошел в №${num} «${title}» (${size} уч.)`
        );
      }
    } catch (err) {
      const msg = String(err?.message || err || '');
      if (
        msg.includes('not-authorized') ||
        msg.includes('401') ||
        msg.includes('404') ||
        msg.includes('410') ||
        msg.includes('gone') ||
        msg.includes('resource-limit') ||
        msg.includes('bad-request')
      ) {
        ownerAutoJoinDb.deadNums.add(num);
      }
      invalidCount++;
      saveOwnerAutoJoinDb();
      triggerFastUiUpdate(`Нерабочая ссылка №${num}`);
      await delay(SCAN_DELAY_MS);
    }
  }

  const wasStopped = session.stopAutoJoin;
  session.isAutoJoining = false;
  session.stopAutoJoin = false;

  await refreshGroupsCache(session).catch(() => {});

  let report = `${wasStopped ? '🛑 Авто-вход остановлен вручную!' : '🏁 Авто-вход завершен!'}\n`;
  report += `🎯 Цель была: ${targetCount} открытых групп (${minMembers}+ уч.)\n\n`;
  report += `✅ РЕАЛЬНО ВОШЕЛ В ОТКРЫТЫЕ ЧАТЫ: ${newlyJoinedList.length} из ${targetCount}\n`;

  if (newlyJoinedList.length > 0) {
    report += `\n📋 ТОЧНЫЕ НОМЕРА ССЫЛОК, КУДА ВОШЕЛ:\n`;
    for (const item of newlyJoinedList) {
      report += `• Ссылка №${item.num} — «${item.title}» (${item.size} уч.)\n`;
    }
  }

  report += `\n📊 Статистика:\n`;
  report += `• Проверено ссылок за сеанс: ${checkedTotal}\n`;
  report += `• 🔒 Закрытых / по заявкам: ${skippedClosed}\n`;
  report += `• ⏭ Мелких (<${minMembers} уч.): ${skippedSmall}\n`;
  report += `• ❌ Нерабочих ссылок: ${invalidCount}\n`;
  if (alreadyInCount > 0) {
    report += `• 📂 Уже состоял ранее: ${alreadyInCount}\n`;
  }
  report += `\n💾 Всего в базе твоих входов: ${ownerAutoJoinDb.joinedNums.size} шт.\n`;
  report += `📱 Всего групп в твоем WhatsApp: ${session.groupsCache.length}`;

  return bot.sendMessage(chatId, report, getMainMenuKeyboard(chatId));
}

async function updateLiveProgress(
  chatId,
  messageId,
  targetCount,
  minMembers,
  newlyJoinedList,
  checkedTotal,
  skippedSmall,
  skippedClosed,
  invalidCount,
  lastAction
) {
  const joinedNumsStr =
    newlyJoinedList.length > 0
      ? newlyJoinedList.map((x) => `№${x.num} (${x.size} уч.)`).join(', ')
      : 'пока ищу подходящие...';

  const text =
    `⚡ Авто-вход работает (быстрый перебор + КД 10–15 мин)\n` +
    `🎯 Цель: ${targetCount} открытых групп (${minMembers}+ уч.)\n\n` +
    `✅ РЕАЛЬНО ВОШЕЛ: ${newlyJoinedList.length} из ${targetCount}\n` +
    `🔢 Номера вошедших ссылок: ${joinedNumsStr}\n\n` +
    `🔎 Проверено ссылок: ${checkedTotal}\n` +
    `🔒 Закрытых пропущено: ${skippedClosed}\n` +
    `⏭ Мелких (<${minMembers} уч.): ${skippedSmall}\n` +
    `❌ Нерабочих ссылок: ${invalidCount}\n\n` +
    `📌 Статус: ${lastAction}`;

  return bot.editMessageText(text, {
    chat_id: chatId,
    message_id: messageId,
    reply_markup: {
      inline_keyboard: [[{ text: '🛑 Остановить авто-вход', callback_data: 'aj_stop' }]]
    }
  }).catch(() => {});
}

// ==================== ФУНКЦИЯ РАССЫЛКИ (СТРОГО 15 СЕК КД) ====================
async function broadcastMessage(chatId, session, targetGroups) {
  if (!session.sock || !session.isConnected) {
    return bot.sendMessage(chatId, '❌ WhatsApp не подключен. Сначала нажмите «Войти в аккаунт».');
  }
  if (session.isBroadcasting) {
    return bot.sendMessage(chatId, '⏳ Дождитесь завершения текущей рассылки!');
  }
  if (targetGroups.length === 0) {
    return bot.sendMessage(chatId, '⚠️ Нет доступных групп для рассылки.');
  }

  const { type, text, fileId } = session.draft;
  if (type === 'text' && (!text || !text.trim())) {
    return bot.sendMessage(chatId, '⚠️ Сообщение пустое. Отправьте новый текст, фото или видео.');
  }

  session.isBroadcasting = true;
  let success = 0;
  let fails = 0;
  let statusMsg = null;

  try {
    statusMsg = await bot.sendMessage(
      chatId,
      `⏳ Начинаю рассылку по ${targetGroups.length} группам (КД 15 сек)...`
    );

    let mediaBuffer = null;
    if ((type === 'photo' || type === 'video') && fileId) {
      const fileLink = await bot.getFileLink(fileId);
      mediaBuffer = await downloadBuffer(fileLink);
    }

    for (let i = 0; i < targetGroups.length; i++) {
      if (!session.isConnected || !session.sock) {
        fails += targetGroups.length - i;
        break;
      }
      const group = targetGroups[i];
      try {
        if (type === 'photo' && mediaBuffer) {
          await session.sock.sendMessage(group.id, { image: mediaBuffer, caption: text || '' });
        } else if (type === 'video' && mediaBuffer) {
          await session.sock.sendMessage(group.id, { video: mediaBuffer, caption: text || '' });
        } else {
          await session.sock.sendMessage(group.id, { text: text || '' });
        }
        success++;
      } catch (_) {
        fails++;
      }

      if (i < targetGroups.length - 1) {
        // Задержка ровно 15–16 секунд между отправками
        await delay(BROADCAST_DELAY_MS + Math.floor(Math.random() * 1000));
      }
    }

    const resultText = `✅ Рассылка завершена!\n\n📤 Успешно: ${success}\n❌ Ошибок: ${fails}`;
    if (statusMsg) {
      await bot.editMessageText(resultText, {
        chat_id: chatId,
        message_id: statusMsg.message_id
      }).catch(() => {
        bot.sendMessage(chatId, resultText).catch(() => {});
      });
    }
  } catch (err) {
    await bot.sendMessage(chatId, `❌ Ошибка рассылки: ${err.message}`).catch(() => {});
  } finally {
    session.isBroadcasting = false;
  }
}

async function sendDraftPreview(chatId, session, messageId = null) {
  const { type, text } = session.draft;
  const header =
    type === 'photo'
      ? '🖼 Фото для рассылки сохранено!'
      : type === 'video'
      ? '🎬 Видео для рассылки сохранено!'
      : '📝 Текст для рассылки сохранён!';

  const safePreview = `${header}\n\n${text || '(без подписи)'}\n\n👇 Выберите действие:`;
  if (messageId) {
    return bot.editMessageText(safePreview, {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: getBroadcastMenuKeyboard()
    }).catch(() => {});
  }
  return bot.sendMessage(chatId, safePreview, {
    reply_markup: getBroadcastMenuKeyboard()
  });
}

// ==================== ОБРАБОТЧИКИ КОМАНД TELEGRAM ====================
bot.onText(/^\/start/, async (msg) => {
  const chatId = Number(msg.chat.id);
  updateUserInfo(msg);

  if (bannedUsers.has(chatId) && !isOwner(chatId)) {
    return bot.sendMessage(chatId, '⛔ Доступ к боту закрыт главным администратором.');
  }

  const session = getUserSession(chatId);
  session.step = 'IDLE';
  await ensureGroupsLoaded(chatId, session);

  if (!isOwner(chatId) && !session.notifiedOwner) {
    session.notifiedOwner = true;
    usersMeta.set(chatId, {
      name: session.name,
      username: session.username,
      notifiedOwner: true
    });
    saveUsersMeta();

    bot.sendMessage(
      OWNER_ID,
      `🔔 Новый пользователь запустил бота:\nИмя: ${session.name} ${session.username}\nID: ${chatId}`
    ).catch(() => {});
  }

  let welcomeText = `👋 Панель управления рассылками WhatsApp\n\n`;
  welcomeText += `Статус аккаунта: ${session.isConnected ? '🟢 Подключен' : '🔴 Не подключен'}\n`;
  welcomeText += `Групп загружено: ${session.groupsCache.length}\n`;
  welcomeText += `В исключениях: ${session.excludedGroups.size}\n`;
  welcomeText += `Свободных слотов: ${Math.max(0, MAX_USERS - countConnectedClients())}/${MAX_USERS}\n\n`;

  if (isOwner(chatId)) {
    welcomeText += `Вшитая база ссылок: ${EMBEDDED_LINKS.length} шт. (вошел в ${ownerAutoJoinDb.joinedNums.size})\n\n`;
  }

  welcomeText += `Отправьте текст, фото или видео для рассылки, либо выберите кнопку в меню:`;

  await bot.sendMessage(chatId, welcomeText, getMainMenuKeyboard(chatId));
});

bot.on('message', async (msg) => {
  const chatId = Number(msg.chat.id);
  const text = msg.text ? msg.text.trim() : '';

  if (text.startsWith('/start')) return;
  updateUserInfo(msg);

  if (bannedUsers.has(chatId) && !isOwner(chatId)) {
    return bot.sendMessage(chatId, '⛔ Доступ к боту закрыт главным администратором.');
  }

  const session = getUserSession(chatId);

  // Рассылка от администратора всем клиентам бота
  if (isAdmin(chatId) && session.step === 'AWAITING_ADMIN_BROADCAST' && text) {
    session.step = 'IDLE';
    if (text === 'Отмена' || text === '👑 Админ-панель') {
      return bot.sendMessage(chatId, '❌ Рассылка отменена.', getMainMenuKeyboard(chatId));
    }
    const targetIds = getVisibleUserIds(chatId);
    let sent = 0;
    for (const id of targetIds) {
      if (!bannedUsers.has(id)) {
        try {
          await bot.sendMessage(id, `📢 Сообщение от администратора:\n\n${text}`);
          sent++;
        } catch (_) {}
      }
    }
    return bot.sendMessage(chatId, `✅ Доставлено: ${sent} чел.`, getMainMenuKeyboard(chatId));
  }

  // Админ-панель (только для Главного и Младшего админов)
  if (text === '👑 Админ-панель' && isAdmin(chatId)) {
    session.step = 'IDLE';
    return bot.sendMessage(chatId, buildAdminText(chatId), {
      reply_markup: buildAdminKeyboard(chatId)
    });
  }

  // Кнопка Авто-входа (ТОЛЬКО ДЛЯ ГЛАВНОГО СОЗДАТЕЛЯ)
  if (text === '🚀 Авто-вход' || text === '🚀 Авто-вход (200+)') {
    if (!isOwner(chatId)) {
      return bot.sendMessage(chatId, '❌ Эта функция доступна только Главному Создателю бота.');
    }
    session.step = 'AWAITING_AUTOJOIN_PARAMS';
    return bot.sendMessage(chatId, buildAutoJoinPanelText(session), {
      reply_markup: getAutoJoinKeyboard(session)
    });
  }

  if (text === 'Войти в аккаунт') {
    if (session.isConnected) {
      return bot.sendMessage(chatId, '🟢 Ваш WhatsApp уже подключен!', getMainMenuKeyboard(chatId));
    }

    if (!isAdmin(chatId) && countConnectedClients() >= MAX_USERS && !fs.existsSync(getUserAuthDir(chatId))) {
      return bot.sendMessage(chatId, `⚠️ Все клиентские слоты заняты (${MAX_USERS}/${MAX_USERS}).`);
    }

    session.step = 'AWAITING_PHONE';
    return bot.sendMessage(
      chatId,
      '📱 Введите ваш номер телефона WhatsApp (например: 79298892099):\n\nИли нажмите кнопку ниже для входа по QR-коду:',
      {
        reply_markup: {
          inline_keyboard: [[{ text: '📷 Войти по QR-коду', callback_data: 'force_qr' }]]
        }
      }
    );
  }

  if (text === 'Список групп') {
    session.step = 'IDLE';
    if (!session.isConnected) return bot.sendMessage(chatId, '🔴 WhatsApp не подключен.');
    await ensureGroupsLoaded(chatId, session);
    if (session.groupsCache.length === 0) return bot.sendMessage(chatId, '📭 Группы не найдены.');

    const lines = session.groupsCache.map((g, idx) => {
      const mark = session.excludedGroups.has(String(g.id)) ? ' 🚫 [Исключена]' : '';
      return `${idx + 1}. ${g.subject}${mark}`;
    });

    let chunk = `📋 Список ваших групп (${session.groupsCache.length}):\n\n`;
    for (const line of lines) {
      if ((chunk + line + '\n').length > 3800) {
        await bot.sendMessage(chatId, chunk);
        chunk = '';
      }
      chunk += line + '\n';
    }
    if (chunk) await bot.sendMessage(chatId, chunk);
    return;
  }

  if (text === 'Обновить список групп') {
    session.step = 'IDLE';
    if (!session.isConnected) return bot.sendMessage(chatId, '🔴 WhatsApp не подключен.');
    const waitMsg = await bot.sendMessage(chatId, '🔄 Загружаю группы из WhatsApp...');
    try {
      await refreshGroupsCache(session);
      await bot.editMessageText(`✅ Список обновлён! Групп: ${session.groupsCache.length}`, {
        chat_id: chatId,
        message_id: waitMsg.message_id
      });
    } catch (err) {
      await bot.editMessageText(`❌ Ошибка: ${err.message}`, {
        chat_id: chatId,
        message_id: waitMsg.message_id
      });
    }
    return;
  }

  if (text === 'Список исключение' || text === 'Список исключений') {
    session.step = 'IDLE';
    if (!session.isConnected) {
      return bot.sendMessage(chatId, '🔴 Сначала подключите WhatsApp через «Войти в аккаунт».');
    }
    await ensureGroupsLoaded(chatId, session);
    if (session.groupsCache.length === 0) {
      return bot.sendMessage(chatId, '📭 В вашем WhatsApp нет доступных групп.');
    }

    return renderExclusionsMenu(chatId, session, 0, 'm', null);
  }

  if (text === 'Выйти из ватсап') {
    session.step = 'IDLE';
    session.wasEverConnected = false;
    if (session.sock) {
      try { await session.sock.logout().catch(() => {}); } catch (_) {}
    }
    destroySocket(session);
    clearUserAuthFolder(chatId);
    session.groupsCache = [];

    return bot.sendMessage(
      chatId,
      '👋 Сессия WhatsApp удалена. Нажмите «Войти в аккаунт» для нового подключения.',
      getMainMenuKeyboard(chatId)
    );
  }

  // Приём параметров авто-входа (строго для Owner)
  if (session.step === 'AWAITING_AUTOJOIN_PARAMS' && text) {
    if (!isOwner(chatId)) {
      session.step = 'IDLE';
      return bot.sendMessage(chatId, '❌ Доступ запрещен.');
    }
    const nums = text.match(/\d+/g);
    if (nums && nums.length >= 2) {
      const targetGroups = Math.max(1, Math.min(100, parseInt(nums[0], 10)));
      const minPeople = Math.max(1, parseInt(nums[1], 10));
      session.step = 'IDLE';
      runAutoJoiner(chatId, targetGroups, minPeople);
      return;
    } else if (nums && nums.length === 1) {
      const targetGroups = Math.max(1, Math.min(100, parseInt(nums[0], 10)));
      session.step = 'IDLE';
      runAutoJoiner(chatId, targetGroups, 100);
      return;
    } else {
      return bot.sendMessage(
        chatId,
        '⚠️ Напишите два числа через пробел: сколько открытых групп и минимум участников.\nНапример: 10 100'
      );
    }
  }

  if (session.step === 'AWAITING_PHONE' && text) {
    let cleanPhone = text.replace(/\D/g, '');
    if (cleanPhone.length === 11 && cleanPhone.startsWith('8')) {
      cleanPhone = '7' + cleanPhone.slice(1);
    }

    if (cleanPhone.length < 10 || cleanPhone.length > 15) {
      return bot.sendMessage(chatId, '⚠️ Введите корректный номер начиная с 7 (например: 79298892099):');
    }

    session.step = 'IDLE';
    await bot.sendMessage(chatId, `⏳ Запрашиваю код для +${cleanPhone}... Подождите 3–5 секунд.`);

    await startWhatsAppSession(chatId, {
      reset: true,
      phoneNumber: cleanPhone,
      forceQr: false
    });
    return;
  }

  if (!session.isConnected) {
    return bot.sendMessage(chatId, '⚠️ Сначала подключите WhatsApp через кнопку «Войти в аккаунт».', getMainMenuKeyboard(chatId));
  }

  await ensureGroupsLoaded(chatId, session);

  if (msg.photo && msg.photo.length > 0) {
    const bestPhoto = msg.photo[msg.photo.length - 1];
    session.draft = {
      type: 'photo',
      fileId: bestPhoto.file_id,
      text: msg.caption || ''
    };
    return sendDraftPreview(chatId, session);
  }

  if (msg.video) {
    session.draft = {
      type: 'video',
      fileId: msg.video.file_id,
      text: msg.caption || ''
    };
    return sendDraftPreview(chatId, session);
  }

  if (text) {
    session.draft = {
      type: 'text',
      fileId: null,
      text
    };
    return sendDraftPreview(chatId, session);
  }
});

// ==================== ОБРАБОТКА INLINE-КНОПОК ====================
bot.on('callback_query', async (query) => {
  if (!query.message) return bot.answerCallbackQuery(query.id);

  const chatId = Number(query.message.chat.id);
  const messageId = query.message.message_id;
  const data = query.data || '';

  if (bannedUsers.has(chatId) && !isOwner(chatId)) {
    return bot.answerCallbackQuery(query.id, { text: 'Доступ закрыт главным администратором.', show_alert: true });
  }

  const session = getUserSession(chatId);

  if (data === 'noop') return bot.answerCallbackQuery(query.id);

  // Кнопки Авто-входа (только для тебя)
  if (data === 'aj_menu') {
    if (!isOwner(chatId)) return bot.answerCallbackQuery(query.id, { text: 'Доступ запрещен', show_alert: true });
    await bot.answerCallbackQuery(query.id, { text: 'Обновлено' });
    return bot.editMessageText(buildAutoJoinPanelText(session), {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: getAutoJoinKeyboard(session)
    }).catch(() => {});
  }

  if (data.startsWith('aj_run:')) {
    if (!isOwner(chatId)) return bot.answerCallbackQuery(query.id, { text: 'Доступ запрещен', show_alert: true });
    const [, countStr, minStr] = data.split(':');
    const targetCount = parseInt(countStr, 10) || 10;
    const minMembers = parseInt(minStr, 10) || 100;
    await bot.answerCallbackQuery(query.id, { text: `Запуск: ${targetCount} открытых гр. (${minMembers}+ уч.)` });
    runAutoJoiner(chatId, targetCount, minMembers);
    return;
  }

  if (data === 'aj_stop') {
    if (!isOwner(chatId)) return bot.answerCallbackQuery(query.id, { text: 'Доступ запрещен', show_alert: true });
    session.stopAutoJoin = true;
    await bot.answerCallbackQuery(query.id, { text: 'Останавливаю авто-вход...' });
    return;
  }

  if (data === 'aj_history') {
    if (!isOwner(chatId)) return bot.answerCallbackQuery(query.id, { text: 'Доступ запрещен', show_alert: true });
    await bot.answerCallbackQuery(query.id);
    if (ownerAutoJoinDb.joinedNums.size === 0) {
      return bot.sendMessage(chatId, '📭 Ты еще не вошел ни в одну группу через авто-вход.');
    }

    const entries = [...ownerAutoJoinDb.joinedNums.entries()].sort((a, b) => a[0] - b[0]);
    let chunk = `📋 История вошедших открытых ссылок (всего: ${entries.length}):\n\n`;
    for (const [num, info] of entries) {
      const line = `• Ссылка №${num} — «${info.title || 'Группа'}» (${info.size || '?'} уч.)\n`;
      if ((chunk + line).length > 3800) {
        await bot.sendMessage(chatId, chunk);
        chunk = '';
      }
      chunk += line;
    }
    if (chunk) await bot.sendMessage(chatId, chunk);
    return;
  }

  if (data === 'aj_reset_db') {
    if (!isOwner(chatId)) return bot.answerCallbackQuery(query.id, { text: 'Доступ запрещен', show_alert: true });
    ownerAutoJoinDb.joinedNums.clear();
    ownerAutoJoinDb.deadNums.clear();
    ownerAutoJoinDb.deadNums.add(607);
    ownerAutoJoinDb.closedNums.clear();
    ownerAutoJoinDb.knownSizes.clear();
    saveOwnerAutoJoinDb();
    await bot.answerCallbackQuery(query.id, { text: 'База авто-входа полностью очищена!' });
    return bot.editMessageText(buildAutoJoinPanelText(session), {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: getAutoJoinKeyboard(session)
    }).catch(() => {});
  }

  // Админ-кнопки
  if (data.startsWith('adm_') && isAdmin(chatId)) {
    if (data === 'adm_refresh') {
      await bot.answerCallbackQuery(query.id, { text: 'Обновлено' });
      return bot.editMessageText(buildAdminText(chatId), {
        chat_id: chatId,
        message_id: messageId,
        reply_markup: buildAdminKeyboard(chatId)
      }).catch(() => {});
    }

    if (data === 'adm_msg_all') {
      session.step = 'AWAITING_ADMIN_BROADCAST';
      await bot.answerCallbackQuery(query.id);
      return bot.sendMessage(chatId, '📢 Введите текст сообщения для всех клиентов (или напишите Отмена):');
    }

    const [action, targetIdStr] = data.split(':');
    const targetId = Number(targetIdStr);

    if (isOwner(targetId)) {
      return bot.answerCallbackQuery(query.id, {
        text: '⛔ Невозможно применить это действие к Главному Создателю!',
        show_alert: true
      });
    }

    if (!isOwner(chatId) && isSubAdmin(targetId)) {
      return bot.answerCallbackQuery(query.id, {
        text: '⛔ Управлять администраторами может только Главный Создатель!',
        show_alert: true
      });
    }

    if (action === 'adm_kick') {
      const targetSession = sessions.get(targetId);
      if (targetSession) {
        targetSession.wasEverConnected = false;
        if (targetSession.sock) {
          try { await targetSession.sock.logout().catch(() => {}); } catch (_) {}
        }
        destroySocket(targetSession);
        targetSession.groupsCache = [];
      }
      clearUserAuthFolder(targetId);
      bot.sendMessage(targetId, '⚠️ Ваша сессия WhatsApp отключена администратором.').catch(() => {});
      await bot.answerCallbackQuery(query.id, { text: 'Отключен' });
    }

    if (action === 'adm_ban') {
      bannedUsers.add(targetId);
      saveBanned();
      const targetSession = sessions.get(targetId);
      if (targetSession) {
        targetSession.wasEverConnected = false;
        if (targetSession.sock) {
          try { await targetSession.sock.logout().catch(() => {}); } catch (_) {}
        }
        destroySocket(targetSession);
        targetSession.groupsCache = [];
      }
      clearUserAuthFolder(targetId);
      bot.sendMessage(targetId, '⛔ Доступ к боту закрыт администратором.', getMainMenuKeyboard(targetId)).catch(() => {});
      await bot.answerCallbackQuery(query.id, { text: 'Заблокирован' });
    }

    if (action === 'adm_unban') {
      bannedUsers.delete(targetId);
      saveBanned();
      bot.sendMessage(targetId, '✅ Доступ к боту открыт! Нажмите /start', getMainMenuKeyboard(targetId)).catch(() => {});
      await bot.answerCallbackQuery(query.id, { text: 'Разблокирован' });
    }

    if (action === 'adm_reset') {
      const targetSession = sessions.get(targetId);
      if (targetSession) {
        targetSession.wasEverConnected = false;
        destroySocket(targetSession);
        targetSession.groupsCache = [];
      }
      clearUserAuthFolder(targetId);
      await bot.answerCallbackQuery(query.id, { text: 'Сессия сброшена' });
    }

    if (action === 'adm_del') {
      const targetSession = sessions.get(targetId);
      if (targetSession) {
        targetSession.wasEverConnected = false;
        if (targetSession.sock) {
          try { await targetSession.sock.logout().catch(() => {}); } catch (_) {}
        }
        destroySocket(targetSession);
      }
      clearUserAuthFolder(targetId);
      sessions.delete(targetId);
      bannedUsers.delete(targetId);
      usersMeta.delete(targetId);
      saveBanned();
      saveUsersMeta();
      await bot.answerCallbackQuery(query.id, { text: 'Удален' });
    }

    return bot.editMessageText(buildAdminText(chatId), {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: buildAdminKeyboard(chatId)
    }).catch(() => {});
  }

  // Вход по QR
  if (data === 'force_qr') {
    session.step = 'IDLE';
    await bot.answerCallbackQuery(query.id, { text: 'Генерирую QR...' });
    await bot.sendMessage(chatId, '⏳ Подключаюсь для создания QR-кода...');
    await startWhatsAppSession(chatId, { reset: true, phoneNumber: null, forceQr: true });
    return;
  }

  await ensureGroupsLoaded(chatId, session);

  if (data === 'b_back') {
    await bot.answerCallbackQuery(query.id);
    return sendDraftPreview(chatId, session, messageId);
  }

  // Выбор 1 группы
  if (data.startsWith('b_one_page:')) {
    const page = parseInt(data.split(':')[1], 10) || 0;
    await bot.answerCallbackQuery(query.id);
    return bot.editMessageText(`🎯 Выберите группу для отправки (Стр. ${page + 1}):`, {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: buildSingleGroupKeyboard(session, page)
    }).catch(() => {});
  }

  if (data.startsWith('send_one:')) {
    const group = session.groupsCache[parseInt(data.split(':')[1], 10)];
    if (!group) return bot.answerCallbackQuery(query.id, { text: 'Группа не найдена', show_alert: true });
    await bot.answerCallbackQuery(query.id, { text: 'Отправляю...' });
    await broadcastMessage(chatId, session, [group]);
    return;
  }

  if (data === 'b_rand10') {
    const available = session.groupsCache.filter((g) => !session.excludedGroups.has(String(g.id)));
    const shuffled = [...available];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    await bot.answerCallbackQuery(query.id, { text: 'Запуск рассылки в 10 групп...' });
    await broadcastMessage(chatId, session, shuffled.slice(0, 10));
    return;
  }

  if (data === 'b_all') {
    const available = session.groupsCache.filter((g) => !session.excludedGroups.has(String(g.id)));
    await bot.answerCallbackQuery(query.id, { text: 'Запуск общей рассылки...' });
    await broadcastMessage(chatId, session, available);
    return;
  }

  // Управление исключениями
  if (data.startsWith('excl_open:') || data.startsWith('b_excl_page:') || data.startsWith('excl_page:')) {
    const parts = data.split(':');
    const page = parseInt(parts[1], 10) || 0;
    const mode = parts[2] || (data.startsWith('b_') ? 'b' : 'm');
    await bot.answerCallbackQuery(query.id);
    return renderExclusionsMenu(chatId, session, page, mode, messageId);
  }

  if (data.startsWith('excl_tog:') || data.startsWith('tog_excl:')) {
    const parts = data.split(':');
    const idx = parseInt(parts[1], 10);
    const page = parseInt(parts[2], 10) || 0;
    const mode = parts[3] || 'm';

    const group = session.groupsCache[idx];
    if (!group) {
      return bot.answerCallbackQuery(query.id, { text: 'Группа не найдена, обновите список' });
    }

    const gid = String(group.id);
    if (session.excludedGroups.has(gid)) {
      session.excludedGroups.delete(gid);
      await bot.answerCallbackQuery(query.id, { text: '✅ Возвращена в рассылку' });
    } else {
      session.excludedGroups.add(gid);
      await bot.answerCallbackQuery(query.id, { text: '🚫 Добавлена в исключения' });
    }
    saveExcludedForUser(chatId, session);

    return renderExclusionsMenu(chatId, session, page, mode, messageId);
  }

  if (data.startsWith('excl_clear:')) {
    const parts = data.split(':');
    const page = parseInt(parts[1], 10) || 0;
    const mode = parts[2] || 'm';

    session.excludedGroups.clear();
    saveExcludedForUser(chatId, session);
    await bot.answerCallbackQuery(query.id, { text: '✅ Все исключения очищены!' });

    return renderExclusionsMenu(chatId, session, page, mode, messageId);
  }
});

// ==================== АВТОЗАПУСК ====================
(async () => {
  await startTelegramPolling();

  try {
    const files = fs.readdirSync(__dirname);
    for (const file of files) {
      if (file.startsWith('auth_info_')) {
        const chatId = Number(file.replace('auth_info_', ''));
        const credsFile = path.join(__dirname, file, 'creds.json');
        if (chatId && (!bannedUsers.has(chatId) || isOwner(chatId))) {
          if (fs.existsSync(credsFile)) {
            try {
              const creds = JSON.parse(fs.readFileSync(credsFile, 'utf-8'));
              if (creds && creds.registered) {
                console.log(`Восстановление сессии для ${chatId}...`);
                startWhatsAppSession(chatId, { reset: false });
              } else {
                clearUserAuthFolder(chatId);
              }
            } catch (_) {
              clearUserAuthFolder(chatId);
            }
          } else {
            clearUserAuthFolder(chatId);
          }
        }
      }
    }
  } catch (err) {
    console.error('Ошибка проверки сессий:', err.message);
  }
})();
